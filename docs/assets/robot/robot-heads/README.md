# Robot Heads — JavaScript port for Lumen

Source: https://github.com/fayazara/robot-heads
Upstream revision: 58ebf6439a8125a769f63b22ffd35bc18834b1b5
Author: Fayaz Ahmed (Fayazara). MIT license preserved in LICENSE.

The color, ticker and tv modules are the upstream TypeScript implementation
transpiled with esbuild to ES2020 ES modules. Relative imports use .js extensions.
No React component or React runtime is included. Lumen's native DOM lifecycle
adapter is ../robot-head.js; it uses the same simulation, lighting and Canvas 2D
renderer as upstream. The default rectangle, blue shell and antenna are retained.

The existing orbAvatarMode preference accepts robot-head in addition to orb and
custom. The shared orb.js entry point applies this choice to Lumen surfaces.
Activity and mood attributes drive the LED face; action execution has priority.
Hidden/disabled avatars stop subscribing to animation. Reduced motion and the
performance mode use static state poses. The preference does not require a GLB
or a network request at runtime.

Validation: node --test scripts/test-robot-head.mjs scripts/test-frontend-build.mjs
The optional native Canvas test runs when @napi-rs/canvas is available locally.

Lumen settings expose the four shapes, shell/trim/LED colors, speed (0–3×),
pause, antenna, floor shadow and pointer/click interaction. The validated
configuration is saved as robotHeadOptions JSON and carried through settings
previews, persistence and the shared appearance API. Size uses orbSize; Desktop
keeps its independent draggable/resizable avatar size, and conversation replies
keep Lumen's compact 34 px mascot. The settings preview offers all nine states
without overriding the live agent's activity.

robot-head.css overrides the generic orb canvas width/height/inset rules so the
upstream padded canvas retains its real dimensions and centre in every surface.
Preview harness: /__preview-robot-head.html (excluded from release packaging).
