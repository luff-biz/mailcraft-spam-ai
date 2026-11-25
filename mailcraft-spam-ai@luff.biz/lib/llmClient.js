// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff
//
// Asks a language model for a spam verdict: Ollama (/api/chat) or any
// OpenAI-compatible endpoint (/chat/completions). The answer is forced into a
// JSON schema and the temperature is 0, so the same mail gets the same value.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {lookupApiKey} from './secrets.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const REQUEST_TIMEOUT_SECONDS = 300;

export const VERDICT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        explanation: {type: 'string'},
        spamValue: {type: 'integer', minimum: 0, maximum: 100},
    },
    required: ['explanation', 'spamValue'],
    additionalProperties: false,
});

/**
 * The model answered, but not with a usable verdict. Unlike a network error,
 * this concerns one message: trying it a few more times makes sense.
 */
export class VerdictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'VerdictError';
    }
}

/**
 * The endpoint answered with an HTTP error status.
 */
export class HttpError extends Error {
    constructor(url, status, text) {
        super(`${url} answered ${status}: ${text.slice(0, 200)}`);
        this.name = 'HttpError';
        this.status = status;
    }

    /**
     * @returns {boolean} whether the error concerns the request itself (and so
     *   probably this one message) rather than the endpoint as a whole
     */
    get aboutRequest() {
        return [400, 413, 422].includes(this.status);
    }
}

/**
 * @param {string} endpoint the endpoint's base address
 * @returns {boolean} whether it is on this computer
 */
export function isLocalEndpoint(endpoint) {
    try {
        const host = GLib.Uri.parse(endpoint, GLib.UriFlags.NONE).get_host() ?? '';
        return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase()) ||
            /^127\./.test(host);
    } catch {
        return false;
    }
}

function joinUrl(base, path) {
    return `${base.replace(/\/+$/, '')}${path}`;
}

// Fixed context lengths for Ollama: the same size for most mail, so Ollama
// does not reload the model between messages.
const CONTEXT_STEPS = [8192, 16384, 32768, 65536];

/**
 * A context length that holds the prompt and the answer. Counted in UTF-8
 * bytes, which is on the safe side for scripts such as Chinese or Hindi,
 * where one character can be more than one token.
 *
 * @param {string} prompt the full prompt
 * @returns {number} num_ctx for Ollama
 */
function contextLength(prompt) {
    const tokens = Math.ceil(new TextEncoder().encode(prompt).length / 2.5) + 512;
    return CONTEXT_STEPS.find(step => step >= tokens) ?? CONTEXT_STEPS.at(-1);
}

/**
 * Checks the model's answer and turns it into a verdict. Anything that is not
 * exactly a value from 0 to 100 and a text is refused, so a malformed answer
 * never moves a message.
 *
 * @param {string} text the model's answer
 * @returns {{spamValue: number, explanation: string}} the verdict
 */
export function parseVerdict(text) {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match)
        throw new VerdictError('The model did not answer with JSON');
    let object;
    try {
        object = JSON.parse(match[0]);
    } catch {
        throw new VerdictError('The model answered with broken JSON');
    }
    const value = object?.spamValue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100)
        throw new VerdictError('The model gave no spam value from 0 to 100');
    return {
        spamValue: value,
        explanation: String(object.explanation ?? '').slice(0, 300),
    };
}

export class LlmClient {
    /**
     * @param {object} config
     * @param {string} config.backend 'ollama' or 'openai'
     * @param {string} config.endpoint base address of the endpoint
     * @param {string} config.model model name
     * @param {Gio.Cancellable} cancellable cancels pending requests
     */
    constructor({backend, endpoint, model}, cancellable) {
        this._backend = backend;
        this._endpoint = endpoint;
        this._model = model;
        this._cancellable = cancellable;
        this._session = new Soup.Session({timeout: REQUEST_TIMEOUT_SECONDS});
        this._encoder = new TextEncoder();
        this._decoder = new TextDecoder();
    }

    async _request(method, url, body = null) {
        const message = Soup.Message.new(method, url);
        if (!message)
            throw new Error(`Not a valid address: ${url}`);
        if (body !== null) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(this._encoder.encode(JSON.stringify(body))));
        }
        if (this._backend === 'openai') {
            const key = await lookupApiKey(this._endpoint, this._cancellable);
            if (key)
                message.get_request_headers().append('Authorization', `Bearer ${key}`);
        }
        const bytes = await this._session.send_and_read_async(message,
            GLib.PRIORITY_DEFAULT, this._cancellable);
        const text = this._decoder.decode(bytes.get_data() ?? new Uint8Array());
        const status = message.get_status();
        if (status < 200 || status >= 300)
            throw new HttpError(url, status, text);
        return JSON.parse(text);
    }

    /**
     * @returns {Promise<string[]>} the model names the endpoint offers
     */
    async listModels() {
        if (this._backend === 'ollama') {
            const answer = await this._request('GET', joinUrl(this._endpoint, '/api/tags'));
            return (answer.models ?? []).map(m => m.name).sort();
        }
        const answer = await this._request('GET', joinUrl(this._endpoint, '/models'));
        return (answer.data ?? []).map(m => m.id).sort();
    }

    /**
     * @param {string} prompt the full prompt
     * @returns {Promise<{spamValue: number, explanation: string}>} the verdict
     */
    async judge(prompt) {
        if (!this._model)
            throw new Error('No model chosen');
        const messages = [{role: 'user', content: prompt}];

        if (this._backend === 'ollama') {
            const numCtx = contextLength(prompt);
            const answer = await this._request('POST', joinUrl(this._endpoint, '/api/chat'), {
                model: this._model,
                messages,
                stream: false,
                format: VERDICT_SCHEMA,
                options: {temperature: 0, num_ctx: numCtx},
            });
            // Ollama cuts a prompt that does not fit without saying so, and the
            // start it drops holds the instructions: such an answer is refused.
            if ((answer.prompt_eval_count ?? 0) >= numCtx - 16)
                throw new VerdictError('The mail did not fit into the model\'s context');
            return parseVerdict(answer.message?.content ?? '');
        }

        const url = joinUrl(this._endpoint, '/chat/completions');
        const request = {
            model: this._model,
            messages,
            temperature: 0,
            response_format: {
                type: 'json_schema',
                json_schema: {name: 'spam_verdict', strict: true, schema: VERDICT_SCHEMA},
            },
        };
        let answer;
        try {
            answer = await this._request('POST', url, request);
        } catch (e) {
            // Some OpenAI-compatible servers do not know json_schema: ask once
            // more without it. The prompt asks for JSON, and parseVerdict
            // checks the answer the same way.
            if (!(e instanceof HttpError) || e.status !== 400)
                throw e;
            delete request.response_format;
            answer = await this._request('POST', url, request);
        }
        return parseVerdict(answer.choices?.[0]?.message?.content ?? '');
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}
