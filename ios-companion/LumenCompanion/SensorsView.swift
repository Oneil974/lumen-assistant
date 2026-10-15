import SwiftUI

/// Réglages « iPhone comme capteur » : chaque source a son interrupteur et son
/// autorisation iOS ; tout part dans le coffre de données.
struct SensorsView: View {
    @Environment(\.palette) private var p
    @State private var sensors = Sensors.shared
    @State private var newPlace = ""
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        SheetScaffold(title: "iPhone comme capteur") {
            Text("Ces données ne vont que dans ton coffre Lumen, sur ton ordinateur. Lumen, ses agents et tes workflows Fluxo peuvent alors s'en servir (« tu as peu dormi », arrivée à la maison…).")
                .font(.system(size: 13)).foregroundStyle(p.mutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4).padding(.bottom, 6)

            toggle("Santé", "heart.fill", "Pas, sommeil, fréquence cardiaque au repos → sante/…", isOn: sensors.health) { on in
                if on { _ = await sensors.enableHealth() } else { sensors.health = false }
            }
            toggle("Agenda et Rappels", "calendar", "7 prochains jours et rappels en cours → agenda/iphone, rappels/iphone", isOn: sensors.calendar) { on in
                if on { _ = await sensors.enableCalendar() } else { sensors.calendar = false }
            }
            toggle("Lieux", "location.fill", "Arrivée / départ de tes lieux → lieu/actuel + workflows « iphone/arrivee/<lieu> »", isOn: sensors.places) { on in
                if on { _ = await sensors.enablePlaces() } else { sensors.places = false }
            }

            if sensors.places {
                SectionLabel("Mes lieux")
                ForEach(sensors.placeList) { place in
                    HStack {
                        Image(systemName: "mappin.circle.fill").foregroundStyle(p.primary)
                        Text(place.name).font(.system(size: 15))
                        Spacer()
                        Text("\(Int(place.radius)) m").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                        Button { sensors.removePlace(place) } label: { Image(systemName: "minus.circle").foregroundStyle(p.destructive) }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                }
                HStack(spacing: 8) {
                    TextField("maison, bureau…", text: $newPlace)
                        .textInputAutocapitalization(.never)
                        .padding(.horizontal, 12).frame(height: 40)
                        .background(p.background, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(p.border))
                    OutlineButton(title: busy ? "…" : "Ajouter ici") {
                        busy = true
                        Task {
                            message = await sensors.addCurrentPlace(named: newPlace)
                            if message == nil { newPlace = "" }
                            busy = false
                        }
                    }
                    .disabled(newPlace.isEmpty || busy)
                }
                .padding(.horizontal, 4)
            }

            if let m = message ?? sensors.error {
                Text(L(m)).font(.system(size: 12)).foregroundStyle(p.destructive).padding(.horizontal, 4)
            }

            SectionLabel("Raccourcis")
            Text("Bouton Action ou tag NFC : dans Raccourcis, utilise « Déclencher un évènement Lumen » (workflows au webhook « iphone/raccourci/<nom> ») ou « Commander le bureau Lumen ». Modes de concentration : Réglages › Concentration › un mode › Filtres › Lumen.")
                .font(.system(size: 13)).foregroundStyle(p.mutedForeground).padding(.horizontal, 4)

            PrimaryButton(title: busy ? "Synchronisation…" : "Synchroniser maintenant", disabled: busy) {
                busy = true
                Task { await sensors.refreshAll(); busy = false; message = nil }
            }
            .padding(.top, 12)
            if let d = sensors.lastSync {
                Text("Dernière synchro : \(d.formatted(date: .omitted, time: .shortened))")
                    .font(.system(size: 12)).foregroundStyle(p.mutedForeground).frame(maxWidth: .infinity)
            }
        }
        .presentationDetents([.large])
    }

    private func toggle(_ title: String, _ symbol: String, _ detail: String, isOn: Bool, action: @escaping (Bool) async -> Void) -> some View {
        Toggle(isOn: Binding(get: { isOn }, set: { on in Task { await action(on) } })) {
            HStack(spacing: 10) {
                Image(systemName: symbol).foregroundStyle(p.primary).frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L(title)).font(.system(size: 15))
                    Text(L(detail)).font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }
}
