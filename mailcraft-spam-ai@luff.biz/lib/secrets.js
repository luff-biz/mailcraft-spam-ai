// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff
//
// API keys for OpenAI-compatible endpoints live in the user's keyring
// (libsecret), one per endpoint address, never in GSettings. libsecret is
// loaded only when a key is needed, so a local Ollama setup does not depend
// on it.

const SCHEMA_NAME = 'org.gnome.shell.extensions.mailcraft-spam-ai.ApiKey';

let _secret = null;
let _schema = null;

// The same endpoint with or without a trailing slash is the same key.
function normalized(endpoint) {
    return endpoint.trim().replace(/\/+$/, '');
}

async function secretModule() {
    if (!_secret) {
        const [{default: Secret}, {default: Gio}] = await Promise.all([
            import('gi://Secret'),
            import('gi://Gio'),
        ]);
        Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
        Gio._promisify(Secret, 'password_store', 'password_store_finish');
        Gio._promisify(Secret, 'password_clear', 'password_clear_finish');
        _schema = new Secret.Schema({
            name: SCHEMA_NAME,
            flags: Secret.SchemaFlags.NONE,
            attributes: {endpoint: Secret.SchemaAttributeType.STRING},
        });
        _secret = Secret;
    }
    return _secret;
}

/**
 * @param {string} endpoint the endpoint address the key belongs to
 * @param {Gio.Cancellable} cancellable cancels the lookup
 * @returns {Promise<string|null>} the key, or null when none is stored
 */
export async function lookupApiKey(endpoint, cancellable = null) {
    const Secret = await secretModule();
    return Secret.password_lookup(_schema, {endpoint: normalized(endpoint)}, cancellable);
}

/**
 * Stores the key for an endpoint, or removes it when the key is empty.
 *
 * @param {string} endpoint the endpoint address
 * @param {string} key the API key
 * @param {string} label how the keyring lists the entry
 */
export async function storeApiKey(endpoint, key, label) {
    const Secret = await secretModule();
    if (!key) {
        await Secret.password_clear(_schema, {endpoint: normalized(endpoint)}, null);
        return;
    }
    await Secret.password_store(_schema, {endpoint: normalized(endpoint)}, Secret.COLLECTION_DEFAULT,
        label, key, null);
}
