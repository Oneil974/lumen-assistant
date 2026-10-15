// Réunion — ce qui reste après la réunion.
//
// Une visio qui ne laisse rien derrière elle oblige à tout retenir. Ici, le fil
// de discussion, la transcription et le compte rendu vivent dans une base
// SQLite ordinaire (« Réunions »), donc lisibles par Prisme, par le NL→SQL, par
// Fluxo et par les agents — et interrogeables des mois plus tard.
import { createStore } from "../lib/table-store.js";

export const SCHEMA = {
  meetings: {
    name: "Réunions",
    columns: [
      ["Titre", "text"], ["Date", "date"], ["Début", "text"], ["Fin", "text"],
      ["Salle", "text"], ["Code", "text"], ["Hôte", "text"], ["Participants", "text"],
      ["Ordre du jour", "text"], ["Compte rendu", "text"], ["Décisions", "text"],
      ["Enregistrement", "text"], ["Durée min", "number"],
    ],
  },
  messages: {
    name: "Messages de réunion",
    columns: [
      ["Salle", "text"], ["Heure", "text"], ["Auteur", "text"], ["Message", "text"],
    ],
  },
  transcript: {
    name: "Transcriptions",
    columns: [
      ["Salle", "text"], ["Heure", "text"], ["Intervenant", "text"], ["Texte", "text"],
    ],
  },
};

export const store = createStore("Réunions", SCHEMA);
