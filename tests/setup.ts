// Pin the process to UTC so default-timezone rendering assertions and date
// fixtures don't depend on the machine (or CI runner) running the tests.
process.env.TZ = "UTC";

import moment from "moment";

// Obsidian exposes its bundled moment as a global; tests run outside the
// Obsidian shell so there is no `window` at all, let alone `window.moment`.
(globalThis as unknown as { window: { moment: typeof moment } }).window = {
	moment,
};
