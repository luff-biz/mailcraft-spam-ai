# MailCraft Spam AI

A GNOME Shell extension that checks new mail in [MailCraft](https://github.com/UCS-Care-Group/mailcraft)
with a language model and moves spam from the inbox to the junk folder.

It builds on the spam filter of the Thunderbird add-on
[ThunderAI](https://micz.it/thunderbird-addon-thunderai/) by Mic (micz): the same prompt, a spam
value from 0 to 100 with a short reason, and a threshold. See [NOTICE.md](NOTICE.md) for what was
taken over and what was changed.

[Deutsch](README.de.md)

## What it does

- Every few minutes it looks at the inbox of the MailCraft accounts you choose and checks the mail
  that arrived since the filter was turned on, one message at a time and each message once. A
  message you take back out of junk is not checked again.
- It keeps running while the screen is locked, so the inbox is sorted when you come back. Nothing
  is shown on the lock screen.
- Senders you trust are not sent to the model: your own skip list, people you have written to
  (looked up in the Sent folder) and your MailCraft contacts. Each source can be turned off. A
  trusted address is only skipped when the sender is verified: DMARC passed (or, without a DMARC
  result, a DKIM signature of the sender's own domain passed) and MailCraft shows no warning about
  the sender. Mail that only claims to come from a trusted address is checked like any other.
- The model gets the sender, the subject, the mail text (shortened to a length you set), the
  sender warnings MailCraft works out itself and the SPF, DKIM and DMARC results of your mail
  server. Its answer is forced into a JSON schema, with temperature 0.
- At or above the threshold the message goes to junk through MailCraft's own *Move to Junk*.
  Nothing is ever deleted, sent or moved back.
- If MailCraft or the model cannot be reached, nothing is moved and the message is checked again
  in the next round. A message that fails on its own (the model gives no usable answer, the
  endpoint refuses it) is tried three times and then left in the inbox; the messages after it
  are still checked. When the same error hits two messages in a row, it is not about the
  messages: the round ends and the toggle shows the error.
- A *Spam Filter* toggle in Quick Settings shows the state and the last messages moved to junk.
  When MailCraft starts or quits, the filter notices within seconds (it watches MailCraft's key
  file) and the toggle follows.
  The last 100 checks are kept in `~/.local/state/mailcraft-spam-ai@luff.biz/`, on this computer
  only.

## Safety

- The extension talks to MailCraft only over its control channel on `127.0.0.1`. Before it sends
  the key, MailCraft has to prove it knows it (`auth.challenge`).
- Every request is marked as coming from an agent with no extra rights. MailCraft then runs only
  what it rates safe on its own and asks you in its window before anything else.
  In addition, the extension only knows five commands: `account.list`, `mail.list`, `mail.get`,
  `mail.junk` and `people.list`.
- The model's answer is only read as a number and a reason. Nothing in it becomes a command.
- The mail text goes to the endpoint you enter and nowhere else. With Ollama on this computer
  (`http://127.0.0.1:11434`, the default), it never leaves your computer. With any other address
  it is sent there, and the settings say so; use `https://` for an endpoint on another computer.
  An API key for an OpenAI-compatible endpoint is kept in the GNOME keyring.

## Requirements

- GNOME Shell 48 to 51
- MailCraft with its control channel open. For the Flatpak, the button **Set Up** in the
  extension's settings does this once for every start: it sets `MAILCRAFT_CONTROL_PORT` and
  `MAILCRAFT_CONTROL_AGENTS_ONLY=1` with `flatpak override --user`, so MailCraft opens the port
  however it is started and treats every request on it as an agent's without rights. **Remove**
  unsets both for MailCraft (`flatpak override --user --unset-env`), also if you had set them
  yourself; other Flatpak settings of MailCraft are left alone. Otherwise start MailCraft with
  `mailcraft --control 7991 --control-agents-only`. The port is set in the extension's settings.
- [Ollama](https://ollama.com) or any OpenAI-compatible endpoint with a model that can answer in
  JSON. Larger general models judge better; local models take a few seconds per message. With
  Ollama, a mail too long for the context the extension allows is refused rather than judged on
  a cut prompt.

## Install from source

```sh
gnome-extensions pack mailcraft-spam-ai@luff.biz \
    --extra-source=lib \
    --schema=schemas/org.gnome.shell.extensions.mailcraft-spam-ai.gschema.xml \
    --podir=../po --gettext-domain=mailcraft-spam-ai
gnome-extensions install --force mailcraft-spam-ai@luff.biz.shell-extension.zip
```

Log out and in again (Wayland), then turn it on in *Extensions*, choose a model in its settings
and switch on *Spam Filter* in Quick Settings.

## Translations

English is the source language. Translations live in `po/`; all of them are machine-assisted and
corrections are welcome. To add strings, update `po/mailcraft-spam-ai.pot` with `xgettext`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
