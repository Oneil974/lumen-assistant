# Memory Blocks

These blocks persist small pieces of state inside a SQLite database that lives on the robot alongside the deployed project. The
robot can therefore keep its working memory even when Rpi-Robot-Studio is offline.

## Storage layout

The generated Python code automatically creates a database file named `robot_memory.db` in the project directory unless you pass a
different path to the blocks. Relative paths are resolved against the running script and any missing folders are created on the
fly. Data is stored in a table named `memory_items` with the columns `namespace`, `key`, `data`, `created_at` and `updated_at`.
Values are serialised as JSON so strings, numbers, booleans and simple objects are supported. When a value cannot be converted to
JSON it is stored as its string representation.

Because the database lives on the Raspberry Pi, the memory service is always available to the robot code without depending on the
editor's Flask API.

## Blocks

- **memory set** – writes the supplied value to the `memory_items` table, creating the namespace/key pair if necessary and updating
  the timestamp on subsequent writes. Leaving the storage path blank uses the default `robot_memory.db` file.
- **memory get** – retrieves the value for the selected namespace/key, returning `None` when nothing is stored.
- **memory delete** – removes the namespace/key entry. Attempting to delete a missing key simply returns without an error.

The helper functions created by these blocks handle all database creation and schema updates automatically, so no additional
configuration is required on the device.
