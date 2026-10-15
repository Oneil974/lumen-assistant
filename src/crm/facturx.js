// Facturation électronique française — calculs, contrôles et Factur-X (CII).
//
// À compter du 1er septembre 2026, toutes les entreprises assujetties à la TVA
// en France doivent POUVOIR RECEVOIR une facture électronique ; l'émission
// devient obligatoire par vagues (grandes entreprises et ETI au 1er septembre
// 2026, PME/TPE au 1er septembre 2027). Le format doit appartenir au socle
// commun : Factur-X (PDF/A-3 + XML CII), UBL ou CII purs. Ce module produit le
// XML CII au profil EN 16931 (« Comfort »), celui qui porte assez de données
// pour les contrôles fiscaux et l'e-reporting.
//
// Références de structure : EN 16931-1 (sémantique), CII D16B (syntaxe),
// spécifications Factur-X 1.0.07 (AFNAR/FNFE-MPE).

// Codes d'unité UN/ECE Rec 20 utilisés par les unités proposées dans l'app.
export const UNIT_CODES = {
  "unité": "C62", "pièce": "H87", "heure": "HUR", "jour": "DAY", "mois": "MON",
  "kg": "KGM", "g": "GRM", "tonne": "TNE", "litre": "LTR", "m": "MTR",
  "m²": "MTK", "m³": "MTQ", "km": "KMT", "forfait": "LS", "lot": "SET",
};

export const unitCode = (u) => UNIT_CODES[String(u || "").trim().toLowerCase()] || "C62";

// Catégories de TVA EN 16931 (BT-118). « S » = taux normal/réduit appliqué.
export const VAT_CATEGORIES = {
  S: "TVA au taux normal ou réduit",
  E: "Exonéré de TVA",
  Z: "Taux zéro",
  AE: "Autoliquidation par le preneur",
  K: "Livraison intracommunautaire exonérée",
  G: "Exportation hors UE exonérée",
};

// Motifs d'exonération exigés sur la facture quand le taux est à 0.
export const EXEMPTION_REASONS = {
  E: "TVA non applicable, article 293 B du CGI",
  Z: "Taux de TVA à 0 %",
  AE: "Autoliquidation — article 283-2 du CGI",
  K: "Exonération TVA — article 262 ter I du CGI (livraison intracommunautaire)",
  G: "Exonération TVA — article 262 I du CGI (exportation)",
};

// Type de document EN 16931 (BT-3) : 380 facture, 381 avoir, 384 facture
// rectificative, 386 facture d'acompte.
export const DOC_TYPES = { "Facture": "380", "Avoir": "381", "Facture rectificative": "384", "Acompte": "386" };

// Moyens de paiement UN/ECE 4461 (BT-81).
export const PAYMENT_MEANS = {
  "Virement": "30", "Prélèvement": "49", "Carte bancaire": "48",
  "Chèque": "20", "Espèces": "10", "Compensation": "97",
};

// Nature de l'opération : mention devenue obligatoire (art. 242 nonies A CGI,
// applicable au 1er septembre 2026).
export const OPERATION_NATURES = {
  "Livraison de biens": "biens",
  "Prestation de services": "services",
  "Opération mixte": "mixte",
};

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const round2 = r2;

/** Total HT d'une ligne, remise de ligne appliquée. */
export function lineTotal(line) {
  const qty = Number(line["Quantité"]) || 0;
  const price = Number(line["Prix HT"]) || 0;
  const disc = Number(line["Remise"]) || 0;
  return r2(qty * price * (1 - disc / 100));
}

/**
 * Totaux d'un document : lignes, remise globale, ventilation par taux de TVA.
 * La ventilation est la partie que les contrôles EN 16931 vérifient le plus
 * (BR-CO-14, BR-S-08…) : un total TVA doit être la somme des TVA par taux,
 * chacune calculée sur sa propre base.
 */
export function computeTotals(lines, globalDiscountPct = 0) {
  const disc = Number(globalDiscountPct) || 0;
  const factor = 1 - disc / 100;
  const byRate = new Map();
  let gross = 0;
  for (const l of lines) {
    const base = lineTotal(l);
    gross += base;
    const net = base * factor;
    const rate = Number(l["TVA"]) || 0;
    const cat = l["Catégorie TVA"] || (rate > 0 ? "S" : "E");
    const key = `${cat}|${rate}`;
    const cur = byRate.get(key) || { category: cat, rate, base: 0, tax: 0 };
    cur.base += net;
    byRate.set(key, cur);
  }
  const vat = [];
  let totalHt = 0;
  let totalTva = 0;
  for (const v of byRate.values()) {
    v.base = r2(v.base);
    v.tax = r2(v.base * v.rate / 100);
    totalHt += v.base;
    totalTva += v.tax;
    vat.push(v);
  }
  vat.sort((a, b) => a.rate - b.rate);
  totalHt = r2(totalHt);
  totalTva = r2(totalTva);
  return {
    gross: r2(gross),
    discount: r2(gross - gross * factor),
    totalHt,
    totalTva,
    totalTtc: r2(totalHt + totalTva),
    vat,
  };
}

/**
 * Contrôles avant émission. Renvoie une liste de { level, field, message } —
 * `error` bloque l'export (la facture serait rejetée par la plateforme),
 * `warn` signale une mention manquante mais non bloquante techniquement.
 */
export function validate(invoice, seller, buyer, lines) {
  const out = [];
  const err = (field, message) => out.push({ level: "error", field, message });
  const warn = (field, message) => out.push({ level: "warn", field, message });

  if (!invoice["Numéro"]) err("numero", "Numéro de facture obligatoire (BT-1), séquentiel et sans rupture.");
  if (!invoice["Date"]) err("date", "Date d'émission obligatoire (BT-2).");
  if (!lines.length) err("lignes", "Une facture doit comporter au moins une ligne (BG-25).");

  if (!seller["Raison sociale"]) err("vendeur", "Raison sociale de l'émetteur obligatoire (BT-27).");
  if (!seller["SIREN"]) err("vendeur", "SIREN de l'émetteur obligatoire : c'est l'identifiant de routage du dispositif français.");
  else if (!/^\d{9}$/.test(String(seller["SIREN"]).replace(/\s/g, ""))) err("vendeur", "SIREN de l'émetteur : 9 chiffres attendus.");
  if (!seller["Adresse"] || !seller["Ville"] || !seller["Code postal"]) err("vendeur", "Adresse postale complète de l'émetteur obligatoire (BG-5).");
  if (seller["Régime TVA"] !== "Franchise en base" && !seller["TVA intracom"]) warn("vendeur", "Numéro de TVA intracommunautaire de l'émetteur attendu (BT-31) hors franchise en base.");

  if (!buyer["Nom"]) err("client", "Nom ou raison sociale du client obligatoire (BT-44).");
  // Mention devenue obligatoire au 1er septembre 2026 pour les clients assujettis.
  if (buyer["Type"] !== "Particulier" && !buyer["SIREN"]) err("client", "SIREN du client obligatoire depuis le 1ᵉʳ septembre 2026 pour un client assujetti (nouvelle mention, art. 242 nonies A CGI).");
  if (!buyer["Adresse"] || !buyer["Ville"] || !buyer["Code postal"]) err("client", "Adresse postale complète du client obligatoire (BG-8).");

  if (!invoice["Nature opération"]) err("nature", "Nature de l'opération (biens / services / mixte) : mention obligatoire depuis le 1ᵉʳ septembre 2026.");
  if (!invoice["Adresse livraison"] && invoice["Nature opération"] !== "Prestation de services") warn("livraison", "Adresse de livraison des biens : mention obligatoire quand elle diffère de l'adresse du client.");
  if (!invoice["Échéance"]) err("echeance", "Date d'échéance du paiement obligatoire (BT-9 ou conditions de paiement).");
  if (Number(seller["Taux pénalités"]) <= 0) warn("penalites", "Taux des pénalités de retard non renseigné (mention obligatoire, art. L441-10 c. com.).");
  if (Number(seller["Indemnité recouvrement"]) !== 40) warn("indemnite", "L'indemnité forfaitaire de recouvrement est fixée à 40 € par la loi.");

  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    if (!l["Désignation"]) err(`ligne-${n}`, `Ligne ${n} : désignation obligatoire (BT-153).`);
    if (!(Number(l["Quantité"]) > 0) && invoice["Type"] !== "Avoir") warn(`ligne-${n}`, `Ligne ${n} : quantité nulle ou négative.`);
    const cat = l["Catégorie TVA"] || (Number(l["TVA"]) > 0 ? "S" : "E");
    if (cat !== "S" && !EXEMPTION_REASONS[cat]) warn(`ligne-${n}`, `Ligne ${n} : motif d'exonération de TVA manquant.`);
  }
  if (invoice["Type"] === "Avoir" && !invoice["Facture rectifiée"]) err("avoir", "Un avoir doit référencer la facture d'origine (BT-25).");
  return out;
}

// L'apostrophe n'est pas échappée : elle est légale telle quelle dans un
// contenu XML comme dans un attribut délimité par des guillemets doubles, et
// « l&apos;opération » rendait les mentions illisibles à la relecture du XML.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const dateFmt = (d) => String(d || "").replace(/-/g, "").slice(0, 8);
const tag = (name, value, attrs = "") =>
  value === undefined || value === null || value === "" ? "" : `<${name}${attrs}>${esc(value)}</${name}>`;

function partyXml(role, p, { legalIdScheme = "0002" } = {}) {
  const siren = String(p["SIREN"] || "").replace(/\s/g, "");
  const siret = String(p["SIRET"] || "").replace(/\s/g, "");
  // Identifiant légal : SIRET (schéma 0009) s'il est connu, sinon SIREN (0002).
  const legalId = siret || siren;
  const scheme = siret ? "0009" : legalIdScheme;
  return `      <ram:${role}>
${legalId ? `        <ram:ID schemeID="${scheme}">${esc(legalId)}</ram:ID>\n` : ""}        <ram:Name>${esc(p["Nom"] || p["Raison sociale"] || "")}</ram:Name>
${legalId ? `        <ram:SpecifiedLegalOrganization>
          <ram:ID schemeID="${scheme}">${esc(legalId)}</ram:ID>
${p["Forme juridique"] ? `          <ram:TradingBusinessName>${esc(p["Raison sociale"])} ${esc(p["Forme juridique"])}</ram:TradingBusinessName>\n` : ""}        </ram:SpecifiedLegalOrganization>\n` : ""}${p["Contact"] || p["Email"] || p["Téléphone"] ? `        <ram:DefinedTradeContact>
${tag("ram:PersonName", p["Contact"]).replace(/^/, "          ")}
${p["Téléphone"] ? `          <ram:TelephoneUniversalCommunication><ram:CompleteNumber>${esc(p["Téléphone"])}</ram:CompleteNumber></ram:TelephoneUniversalCommunication>\n` : ""}${p["Email"] ? `          <ram:EmailURIUniversalCommunication><ram:URIID>${esc(p["Email"])}</ram:URIID></ram:EmailURIUniversalCommunication>\n` : ""}        </ram:DefinedTradeContact>\n` : ""}        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(p["Code postal"] || "")}</ram:PostcodeCode>
          <ram:LineOne>${esc(p["Adresse"] || "")}</ram:LineOne>
          <ram:CityName>${esc(p["Ville"] || "")}</ram:CityName>
          <ram:CountryID>${esc((p["Pays"] || "FR").slice(0, 2).toUpperCase())}</ram:CountryID>
        </ram:PostalTradeAddress>
${p["TVA intracom"] ? `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(p["TVA intracom"])}</ram:ID></ram:SpecifiedTaxRegistration>\n` : ""}      </ram:${role}>`;
}

/**
 * XML Factur-X (CII D16B, profil EN 16931) d'une facture.
 * `invoice` et `buyer`/`seller` sont les objets de la base ; `lines` les lignes.
 */
export function buildXml({ invoice, seller, buyer, lines, totals }) {
  const type = DOC_TYPES[invoice["Type"]] || "380";
  const paid = Number(invoice["Payé"]) || 0;
  const nature = invoice["Nature opération"] || "";
  const notes = [];
  if (nature) notes.push({ code: "AAI", text: `Nature de l'opération : ${nature}.` });
  if (invoice["TVA sur les débits"]) notes.push({ code: "AAI", text: "Option pour le paiement de la TVA d'après les débits." });
  if (seller["Régime TVA"] === "Franchise en base") notes.push({ code: "AAI", text: "TVA non applicable, article 293 B du CGI." });
  if (seller["Mentions"]) notes.push({ code: "REG", text: seller["Mentions"] });
  if (invoice["Notes"]) notes.push({ code: "AAI", text: invoice["Notes"] });
  const penalties = `Pénalités de retard : ${num(seller["Taux pénalités"] || 0)} % par an. Indemnité forfaitaire pour frais de recouvrement : ${num(seller["Indemnité recouvrement"] || 40)} €.${seller["Escompte"] ? ` Escompte : ${seller["Escompte"]}.` : " Pas d'escompte pour paiement anticipé."}`;

  const lineXml = lines.map((l, i) => {
    const rate = Number(l["TVA"]) || 0;
    const cat = l["Catégorie TVA"] || (rate > 0 ? "S" : "E");
    const gross = Number(l["Prix HT"]) || 0;
    const discPct = Number(l["Remise"]) || 0;
    const net = r2(gross * (1 - discPct / 100));
    return `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
${l["Référence"] ? `        <ram:SellerAssignedID>${esc(l["Référence"])}</ram:SellerAssignedID>\n` : ""}        <ram:Name>${esc(l["Désignation"] || "")}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:GrossPriceProductTradePrice><ram:ChargeAmount>${num(gross)}</ram:ChargeAmount></ram:GrossPriceProductTradePrice>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${num(net)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${unitCode(l["Unité"])}">${num(l["Quantité"])}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${cat}</ram:CategoryCode>
          <ram:RateApplicablePercent>${num(rate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${num(lineTotal(l))}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  }).join("\n");

  const taxXml = totals.vat.map((v) => `      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${num(v.tax)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
${v.category !== "S" ? `        <ram:ExemptionReason>${esc(EXEMPTION_REASONS[v.category] || "")}</ram:ExemptionReason>\n` : ""}        <ram:BasisAmount>${num(v.base)}</ram:BasisAmount>
        <ram:CategoryCode>${v.category}</ram:CategoryCode>
${invoice["TVA sur les débits"] || nature === "Livraison de biens" ? "        <ram:DueDateTypeCode>5</ram:DueDateTypeCode>\n" : "        <ram:DueDateTypeCode>72</ram:DueDateTypeCode>\n"}        <ram:RateApplicablePercent>${num(v.rate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join("\n");

  const meansCode = PAYMENT_MEANS[seller["Mode paiement"] || invoice["Mode paiement"]] || "30";

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(invoice["Numéro"])}</ram:ID>
    <ram:TypeCode>${type}</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${dateFmt(invoice["Date"])}</udt:DateTimeString></ram:IssueDateTime>
${notes.map((n) => `    <ram:IncludedNote><ram:Content>${esc(n.text)}</ram:Content><ram:SubjectCode>${n.code}</ram:SubjectCode></ram:IncludedNote>`).join("\n")}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${lineXml}
    <ram:ApplicableHeaderTradeAgreement>
${invoice["Référence acheteur"] ? `      <ram:BuyerReference>${esc(invoice["Référence acheteur"])}</ram:BuyerReference>\n` : ""}${partyXml("SellerTradeParty", seller)}
${partyXml("BuyerTradeParty", buyer)}
${invoice["Bon de commande"] ? `      <ram:BuyerOrderReferencedDocument><ram:IssuerAssignedID>${esc(invoice["Bon de commande"])}</ram:IssuerAssignedID></ram:BuyerOrderReferencedDocument>\n` : ""}${invoice["Devis"] ? `      <ram:QuotationReferencedDocument><ram:IssuerAssignedID>${esc(invoice["Devis"])}</ram:IssuerAssignedID></ram:QuotationReferencedDocument>\n` : ""}    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
${invoice["Adresse livraison"] ? `      <ram:ShipToTradeParty><ram:Name>${esc(buyer["Nom"] || "")}</ram:Name><ram:PostalTradeAddress><ram:LineOne>${esc(invoice["Adresse livraison"])}</ram:LineOne><ram:CountryID>${esc((buyer["Pays"] || "FR").slice(0, 2).toUpperCase())}</ram:CountryID></ram:PostalTradeAddress></ram:ShipToTradeParty>\n` : ""}${invoice["Date livraison"] ? `      <ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${dateFmt(invoice["Date livraison"])}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>\n` : ""}    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>${meansCode}</ram:TypeCode>
${seller["IBAN"] ? `        <ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${esc(String(seller["IBAN"]).replace(/\s/g, ""))}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>\n` : ""}${seller["BIC"] ? `        <ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${esc(seller["BIC"])}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>\n` : ""}      </ram:SpecifiedTradeSettlementPaymentMeans>
${taxXml}
${totals.discount > 0 ? `      <ram:SpecifiedTradeAllowanceCharge>
        <ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>
        <ram:ActualAmount>${num(totals.discount)}</ram:ActualAmount>
        <ram:Reason>Remise commerciale</ram:Reason>
        <ram:CategoryTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${totals.vat[0]?.category || "S"}</ram:CategoryCode><ram:RateApplicablePercent>${num(totals.vat[0]?.rate || 0)}</ram:RateApplicablePercent></ram:CategoryTradeTax>
      </ram:SpecifiedTradeAllowanceCharge>\n` : ""}      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>${esc(`${invoice["Conditions paiement"] || seller["Conditions paiement"] || "Paiement à réception"}. ${penalties}`)}</ram:Description>
${invoice["Échéance"] ? `        <ram:DueDateDateTime><udt:DateTimeString format="102">${dateFmt(invoice["Échéance"])}</udt:DateTimeString></ram:DueDateDateTime>\n` : ""}      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${num(totals.gross)}</ram:LineTotalAmount>
${totals.discount > 0 ? `        <ram:AllowanceTotalAmount>${num(totals.discount)}</ram:AllowanceTotalAmount>\n` : ""}        <ram:TaxBasisTotalAmount>${num(totals.totalHt)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${num(totals.totalTva)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${num(totals.totalTtc)}</ram:GrandTotalAmount>
        <ram:TotalPrepaidAmount>${num(paid)}</ram:TotalPrepaidAmount>
        <ram:DuePayableAmount>${num(r2(totals.totalTtc - paid))}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
${invoice["Facture rectifiée"] ? `      <ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${esc(invoice["Facture rectifiée"])}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>\n` : ""}    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}
