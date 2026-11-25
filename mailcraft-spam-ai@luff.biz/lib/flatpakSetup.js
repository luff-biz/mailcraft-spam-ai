// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff
//
// Lets MailCraft open its control channel on every start, however it is
// started (app grid, launcher, autostart), by setting two environment
// variables for its Flatpak with `flatpak override --user`:
//   MAILCRAFT_CONTROL_PORT=<port>      the control port
//   MAILCRAFT_CONTROL_AGENTS_ONLY=1    every request on it is treated as an
//                                      agent's, allowed nothing in advance
// Only run when the user clicks the button in the preferences. Remove unsets
// both variables for the app (flatpak override --unset-env), whoever set them;
// other overrides of the app are left as they are.

import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export const FLATPAK_ID = 'io.github.billsecond.mailcraft';
const PORT_VAR = 'MAILCRAFT_CONTROL_PORT';
const AGENTS_VAR = 'MAILCRAFT_CONTROL_AGENTS_ONLY';

async function run(argv) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
    if (!proc.get_successful())
        throw new Error((stderr || stdout || `${argv[0]} failed`).trim());
    return stdout ?? '';
}

/**
 * @returns {Promise<{installed: boolean, port: number|null, agentsOnly: boolean}>}
 *   whether MailCraft is installed as a Flatpak and what is set for it
 */
export async function readSetup() {
    try {
        await run(['flatpak', 'info', FLATPAK_ID]);
    } catch {
        return {installed: false, port: null, agentsOnly: false};
    }
    const text = await run(['flatpak', 'override', '--user', '--show', FLATPAK_ID]);
    const env = {};
    let inEnvironment = false;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('['))
            inEnvironment = trimmed === '[Environment]';
        else if (inEnvironment && trimmed.includes('='))
            env[trimmed.slice(0, trimmed.indexOf('='))] = trimmed.slice(trimmed.indexOf('=') + 1);
    }
    const port = parseInt(env[PORT_VAR], 10);
    return {
        installed: true,
        port: Number.isInteger(port) ? port : null,
        agentsOnly: env[AGENTS_VAR] === '1',
    };
}

/**
 * @param {number} port the control port to set
 */
export async function applySetup(port) {
    await run(['flatpak', 'override', '--user',
        `--env=${PORT_VAR}=${port}`, `--env=${AGENTS_VAR}=1`, FLATPAK_ID]);
}

export async function removeSetup() {
    await run(['flatpak', 'override', '--user',
        `--unset-env=${PORT_VAR}`, `--unset-env=${AGENTS_VAR}`, FLATPAK_ID]);
}
