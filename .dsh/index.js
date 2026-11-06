/**
 * Package root of the ECC DeepSeek Harness bundle.
 *
 * The useful plugins are the subpath entries declared in `cordis.patch.yml`:
 * `./skills`, `./commands`, `./hooks`, and `./agents`. This root export keeps
 * the package importable for tooling and for a minimal no-op row.
 */

export const name = 'ecc';

/**
 * No-op plugin: ECC lives in the subpath entries so each surface can be
 * enabled, disabled, or diagnosed independently.
 */
export function apply() {}
