# mfrc522_write

Write a short text payload to a 13.56 MHz RFID tag using an MFRC522 reader/writer.

## Description
Waits for a tag to be presented, erases the writable block, and stores the provided text (converted to a string). Returns `True` when the operation completes successfully.

## Entrées
- **TEXT**: input_value – String expression that contains the data to write. Keep it under 16 characters to fit a single block on most tags.

## Sortie
- _None_ (statement block). The function returns `True`/`False` internally so you can wrap it in logic if necessary.
