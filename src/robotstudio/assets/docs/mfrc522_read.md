# mfrc522_read

Read the UID and stored text payload from a 13.56 MHz RFID tag using an MFRC522 reader.

## Description
Waits for a tag to be presented, then returns a dictionary with the numeric `id` and the string `text` read from the chip. The text is stripped of surrounding whitespace for convenience.

## Entrées
- _None_

## Sortie
- **Dictionary** – `{ "id": <uid>, "text": "<payload>" }`. Returns `None` if the read failed.
