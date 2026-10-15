// Prompts IA de Robot Studio (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.robotstudio.explain": {
    kind: "explain",
    label: "Robot Studio — expliquer le programme",
    role: "Tu expliques un programme Python pour Raspberry Pi à un débutant : ce qu'il fait, le matériel à brancher (broches) et un point d'attention.",
    build: ({ code, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.robotstudio.explain", kind: "explain", lang, role: PROMPTS["app.robotstudio.explain"].role, data: { PROGRAMME: code }, format: "5 à 8 phrases." }),
    }),
    bench: [{ vars: { code: "import RPi.GPIO as GPIO\nimport time\nGPIO.setmode(GPIO.BCM)\nGPIO.setup(17, GPIO.OUT)\nwhile True:\n    GPIO.output(17, True)\n    time.sleep(1)\n    GPIO.output(17, False)\n    time.sleep(1)" },
      expect: { re: ["17", "LED|led|diode|clignot"], lang: "fr" } }],
  },
};
