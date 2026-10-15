import CoreLocation
import EventKit
import Foundation
import HealthKit
import Observation

/// L'iPhone comme capteur pour Lumen. Chaque source s'active séparément, avec
/// l'autorisation iOS correspondante, et n'écrit QUE dans le coffre de données
/// (clés sante/…, lieu/…, agenda/iphone, rappels/iphone) : Lumen, ses agents
/// et Fluxo s'en servent de là. Rien d'autre ne quitte le téléphone.
@MainActor
@Observable
final class Sensors: NSObject {
    static let shared = Sensors()

    var health: Bool { didSet { UserDefaults.standard.set(health, forKey: "sensor.health") } }
    var places: Bool { didSet { UserDefaults.standard.set(places, forKey: "sensor.places") } }
    var calendar: Bool { didSet { UserDefaults.standard.set(calendar, forKey: "sensor.calendar") } }
    private(set) var placeList: [Place] = []
    private(set) var lastSync: Date?
    var error: String?

    struct Place: Codable, Identifiable, Hashable {
        var id: String { name }
        let name: String
        let lat: Double
        let lon: Double
        let radius: Double
    }

    private let healthStore = HKHealthStore()
    private let eventStore = EKEventStore()
    private let locationManager = CLLocationManager()
    private var monitor: CLMonitor?
    private var monitorTask: Task<Void, Never>?

    override init() {
        let d = UserDefaults.standard
        health = d.bool(forKey: "sensor.health")
        places = d.bool(forKey: "sensor.places")
        calendar = d.bool(forKey: "sensor.calendar")
        super.init()
        placeList = (d.data(forKey: "sensor.placeList")).flatMap { try? JSONDecoder().decode([Place].self, from: $0) } ?? []
    }

    /// Au lancement et à chaque retour au premier plan.
    func refreshAll() async {
        if health { await syncHealth() }
        if calendar { await syncCalendar() }
        if places { await startPlaces() }
        await VaultStore.sync()
        lastSync = .now
    }

    // MARK: Santé

    func enableHealth() async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { error = L("Santé indisponible sur cet appareil."); return false }
        let types: Set<HKObjectType> = [
            HKQuantityType(.stepCount), HKQuantityType(.restingHeartRate),
            HKCategoryType(.sleepAnalysis), HKQuantityType(.activeEnergyBurned),
        ]
        do {
            try await healthStore.requestAuthorization(toShare: [], read: types)
            health = true
            await syncHealth()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    private func syncHealth() async {
        let start = Calendar.current.startOfDay(for: .now)
        if let steps = await sum(.stepCount, unit: .count(), from: start) {
            VaultStore.set("sante/pas", .number(steps.rounded()), type: "number")
        }
        if let kcal = await sum(.activeEnergyBurned, unit: .kilocalorie(), from: start) {
            VaultStore.set("sante/calories_actives", .number(kcal.rounded()), type: "number")
        }
        if let hr = await latest(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute())) {
            VaultStore.set("sante/fc_repos", .number(hr.rounded()), type: "number")
        }
        if let sleep = await lastNightSleepHours() {
            VaultStore.set("sante/sommeil_h", .number((sleep * 10).rounded() / 10), type: "number")
        }
        VaultStore.set("sante/maj", .string(ISO8601DateFormatter().string(from: .now)), type: "date")
    }

    private func sum(_ id: HKQuantityTypeIdentifier, unit: HKUnit, from start: Date) async -> Double? {
        await withCheckedContinuation { c in
            let q = HKStatisticsQuery(quantityType: HKQuantityType(id),
                                      quantitySamplePredicate: HKQuery.predicateForSamples(withStart: start, end: .now),
                                      options: .cumulativeSum) { _, stats, _ in
                c.resume(returning: stats?.sumQuantity()?.doubleValue(for: unit))
            }
            healthStore.execute(q)
        }
    }

    private func latest(_ id: HKQuantityTypeIdentifier, unit: HKUnit) async -> Double? {
        await withCheckedContinuation { c in
            let q = HKSampleQuery(sampleType: HKQuantityType(id), predicate: nil, limit: 1,
                                  sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) { _, samples, _ in
                c.resume(returning: (samples?.first as? HKQuantitySample)?.quantity.doubleValue(for: unit))
            }
            healthStore.execute(q)
        }
    }

    /// Sommeil de la nuit (18 h la veille → maintenant), phases « endormi ».
    private func lastNightSleepHours() async -> Double? {
        let start = Calendar.current.date(byAdding: .hour, value: -18, to: Calendar.current.startOfDay(for: .now).addingTimeInterval(86400))!
        let from = min(start, Date().addingTimeInterval(-86400))
        return await withCheckedContinuation { c in
            let q = HKSampleQuery(sampleType: HKCategoryType(.sleepAnalysis),
                                  predicate: HKQuery.predicateForSamples(withStart: from, end: .now), limit: HKObjectQueryNoLimit,
                                  sortDescriptors: nil) { _, samples, _ in
                let asleep = (samples as? [HKCategorySample] ?? []).filter {
                    HKCategoryValueSleepAnalysis.allAsleepValues.map(\.rawValue).contains($0.value)
                }
                let secs = asleep.reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) }
                c.resume(returning: secs > 0 ? secs / 3600 : nil)
            }
            healthStore.execute(q)
        }
    }

    // MARK: Agenda & Rappels

    func enableCalendar() async -> Bool {
        do {
            let ev = try await eventStore.requestFullAccessToEvents()
            let rem = try await eventStore.requestFullAccessToReminders()
            calendar = ev || rem
            if calendar { await syncCalendar() }
            return calendar
        } catch { self.error = error.localizedDescription; return false }
    }

    private func syncCalendar() async {
        let fmt = ISO8601DateFormatter()
        if EKEventStore.authorizationStatus(for: .event) == .fullAccess {
            let pred = eventStore.predicateForEvents(withStart: Calendar.current.startOfDay(for: .now),
                                                     end: .now.addingTimeInterval(7 * 86400), calendars: nil)
            let events = eventStore.events(matching: pred).prefix(60).map { e -> JSONValue in
                .object([
                    "titre": .string(e.title ?? ""), "debut": .string(fmt.string(from: e.startDate)),
                    "fin": .string(fmt.string(from: e.endDate)), "journee": .bool(e.isAllDay),
                    "lieu": .string(e.location ?? ""), "agenda": .string(e.calendar.title),
                ])
            }
            VaultStore.set("agenda/iphone", .array(Array(events)), type: "list")
        }
        if EKEventStore.authorizationStatus(for: .reminder) == .fullAccess {
            let pred = eventStore.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
            let reminders: [EKReminder] = await withCheckedContinuation { c in
                eventStore.fetchReminders(matching: pred) { c.resume(returning: $0 ?? []) }
            }
            let items = reminders.prefix(80).map { r -> JSONValue in
                .object([
                    "titre": .string(r.title ?? ""), "liste": .string(r.calendar.title),
                    "echeance": .string(r.dueDateComponents?.date.map { fmt.string(from: $0) } ?? ""),
                ])
            }
            VaultStore.set("rappels/iphone", .array(Array(items)), type: "list")
        }
    }

    // MARK: Lieux (entrée / sortie de zones, sans suivi continu)

    func enablePlaces() async -> Bool {
        locationManager.requestAlwaysAuthorization()
        places = true
        await startPlaces()
        return true
    }

    /// Ajoute la position actuelle comme lieu nommé (« maison », « bureau »).
    func addCurrentPlace(named name: String, radius: Double = 120) async -> String? {
        locationManager.requestWhenInUseAuthorization()
        var loc: CLLocation?
        do {
            for try await u in CLLocationUpdate.liveUpdates() {
                if let l = u.location, l.horizontalAccuracy < 200 { loc = l; break }
            }
        } catch { return error.localizedDescription }
        guard let loc else { return L("Position introuvable.") }
        let place = Place(name: name.trimmingCharacters(in: .whitespaces).lowercased(), lat: loc.coordinate.latitude, lon: loc.coordinate.longitude, radius: radius)
        placeList.removeAll { $0.name == place.name }
        placeList.append(place)
        persistPlaces()
        await startPlaces(restart: true)
        return nil
    }

    func removePlace(_ p: Place) {
        placeList.removeAll { $0 == p }
        persistPlaces()
        Task { await monitor?.remove(p.name) }
    }

    private func persistPlaces() {
        UserDefaults.standard.set(try? JSONEncoder().encode(placeList), forKey: "sensor.placeList")
    }

    private func startPlaces(restart: Bool = false) async {
        guard places, !placeList.isEmpty else { return }
        if monitor == nil || restart {
            monitorTask?.cancel()
            monitor = await CLMonitor("lumen-places")
            for p in placeList {
                await monitor?.add(CLMonitor.CircularGeographicCondition(center: .init(latitude: p.lat, longitude: p.lon), radius: p.radius),
                                   identifier: p.name, assuming: .unsatisfied)
            }
            guard let monitor else { return }
            monitorTask = Task { [weak self] in
                do {
                    for try await event in await monitor.events {
                        await self?.placeEvent(name: event.identifier, inside: event.state == .satisfied)
                    }
                } catch { }
            }
        }
    }

    private func placeEvent(name: String, inside: Bool) async {
        let now = ISO8601DateFormatter().string(from: .now)
        VaultStore.set("lieu/actuel", .string(inside ? name : "ailleurs"))
        VaultStore.set("lieu/\(name)/\(inside ? "arrivee" : "depart")", .string(now), type: "date")
        await VaultStore.sync()
        _ = try? await BackgroundAPI.post("phone/event", ["event": inside ? "arrivee" : "depart", "name": name])
    }
}
