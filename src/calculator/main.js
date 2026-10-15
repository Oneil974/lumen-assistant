// App Calculatrice : scientifique, statistiques et conversions (lib/calc-widget.js).
import { appLang } from "../apps-i18n.js";
import { mountCalculator } from "../lib/calc-widget.js";

const lang = appLang();
document.documentElement.lang = lang;
document.title = lang === "en" ? "Lumen — Calculator" : "Lumen — Calculatrice";
mountCalculator(document.getElementById("calc"), { lang }).focus();
