# MailCraft Spam AI

Eine GNOME-Shell-Erweiterung, die neue Mails in [MailCraft](https://github.com/UCS-Care-Group/mailcraft)
mit einem Sprachmodell prüft und Spam vom Posteingang in den Spam-Ordner verschiebt.

Grundlage ist der Spamfilter der Thunderbird-Erweiterung
[ThunderAI](https://micz.it/thunderbird-addon-thunderai/) von Mic (micz): derselbe Prompt, ein
Spam-Wert von 0 bis 100 mit kurzer Begründung und eine Schwelle. Was übernommen und was geändert
wurde, steht in [NOTICE.md](NOTICE.md).

[English](README.md)

## Was sie tut

- Alle paar Minuten sieht sie in den Posteingang der gewählten MailCraft-Konten und prüft die
  Mails, die seit dem Einschalten angekommen sind, eine nach der anderen und jede nur einmal.
  Eine Mail, die Sie aus dem Spam-Ordner zurückholen, wird nicht erneut geprüft.
- Sie läuft auch bei gesperrtem Bildschirm weiter, damit der Posteingang sortiert ist, wenn Sie
  zurückkommen. Auf dem Sperrbildschirm wird nichts angezeigt.
- Vertrauenswürdige Absender gehen nicht an das Modell: die eigene Ausnahmeliste, Personen, denen
  Sie geschrieben haben (nachgesehen im Gesendet-Ordner), und Ihre MailCraft-Kontakte. Jede
  Quelle lässt sich abschalten. Übersprungen wird eine vertrauenswürdige Adresse nur, wenn der
  Absender bestätigt ist: DMARC bestanden (oder ohne DMARC-Ergebnis eine DKIM-Signatur der
  eigenen Domain des Absenders bestanden) und keine Absenderwarnung von MailCraft. Eine Mail, die nur vorgibt, von einer
  vertrauenswürdigen Adresse zu kommen, wird wie jede andere geprüft.
- Das Modell bekommt Absender, Betreff, den Mailtext (auf eine einstellbare Länge gekürzt), die
  Absenderwarnungen von MailCraft und die SPF-, DKIM- und DMARC-Ergebnisse Ihres Mailservers.
  Die Antwort ist auf ein JSON-Schema festgelegt, Temperatur 0.
- Ab der Schwelle geht die Mail über das eigene „In Junk verschieben“ von MailCraft in den
  Spam-Ordner. Es wird nie etwas gelöscht, gesendet oder zurückgeschoben.
- Ist MailCraft oder das Modell nicht erreichbar, wird nichts verschoben und die Mail in der
  nächsten Runde erneut geprüft. Scheitert eine Mail für sich allein (keine brauchbare Antwort
  des Modells, der Endpunkt lehnt sie ab), wird sie dreimal versucht und dann im Posteingang
  gelassen; die Mails danach werden trotzdem geprüft. Trifft derselbe Fehler zwei Mails
  hintereinander, liegt er nicht an den Mails: Die Runde endet, und der Schalter zeigt den Fehler.
- Ein Schalter „Spamfilter“ in den Schnelleinstellungen zeigt den Zustand und die zuletzt
  verschobenen Mails. Die letzten 100 Prüfungen liegen in
  `~/.local/state/mailcraft-spam-ai@luff.biz/`, nur auf diesem Rechner.

## Sicherheit

- Die Erweiterung spricht mit MailCraft nur über dessen Steuerkanal auf `127.0.0.1`. Bevor sie
  den Schlüssel sendet, muss MailCraft beweisen, dass es ihn kennt (`auth.challenge`).
- Jede Anfrage ist als Agent ohne zusätzliche Rechte gekennzeichnet. MailCraft führt dann nur
  von sich aus aus, was es als sicher einstuft, und fragt Sie bei allem anderen vorher im Fenster. Zusätzlich
  kennt die Erweiterung nur fünf Befehle: `account.list`, `mail.list`, `mail.get`, `mail.junk` und
  `people.list`.
- Die Antwort des Modells wird nur als Zahl und Begründung gelesen. Nichts davon wird zu einem
  Befehl.
- Der Mailtext geht an den eingetragenen Endpunkt und sonst nirgendwohin. Mit Ollama auf diesem
  Rechner (`http://127.0.0.1:11434`, die Vorgabe) verlässt er Ihren Rechner nie. Bei jeder anderen
  Adresse geht er dorthin, und die Einstellungen weisen darauf hin; für einen Endpunkt auf einem
  anderen Rechner nehmen Sie `https://`. Der API-Schlüssel eines OpenAI-kompatiblen Endpunkts
  liegt im GNOME-Schlüsselbund.

## Voraussetzungen

- GNOME Shell 48 bis 51
- MailCraft mit geöffnetem Steuerkanal. Beim Flatpak erledigt das der Knopf **Einrichten** in den
  Einstellungen der Erweiterung einmal für jeden Start: Er setzt `MAILCRAFT_CONTROL_PORT` und
  `MAILCRAFT_CONTROL_AGENTS_ONLY=1` mit `flatpak override --user`. MailCraft öffnet den Port dann
  gleich, wie es gestartet wird, und behandelt jede Anfrage darüber als Agent ohne Rechte.
  **Entfernen** nimmt beide für MailCraft zurück (`flatpak override --user --unset-env`), auch
  wenn Sie sie selbst gesetzt hatten; andere Flatpak-Einstellungen von MailCraft bleiben, wie sie
  sind. Sonst starten Sie MailCraft mit `mailcraft --control 7991 --control-agents-only`. Den Port
  stellen Sie in den Einstellungen der Erweiterung ein.
- [Ollama](https://ollama.com) oder ein OpenAI-kompatibler Endpunkt mit einem Modell, das JSON
  liefern kann. Größere allgemeine Modelle urteilen besser; lokale Modelle brauchen einige
  Sekunden je Mail. Mit Ollama wird eine Mail, die zu lang für den erlaubten Kontext ist,
  abgelehnt statt mit abgeschnittenem Prompt bewertet.

## Installation aus dem Quelltext

```sh
gnome-extensions pack mailcraft-spam-ai@luff.biz \
    --extra-source=lib \
    --schema=schemas/org.gnome.shell.extensions.mailcraft-spam-ai.gschema.xml \
    --podir=../po --gettext-domain=mailcraft-spam-ai
gnome-extensions install --force mailcraft-spam-ai@luff.biz.shell-extension.zip
```

Danach ab- und wieder anmelden (Wayland), die Erweiterung unter „Erweiterungen“ einschalten, in
ihren Einstellungen ein Modell wählen und in den Schnelleinstellungen „Spamfilter“ einschalten.

## Übersetzungen

Ausgangssprache ist Englisch. Die Übersetzungen liegen in `po/`; alle sind maschinell erstellt,
Korrekturen sind willkommen. Neue Texte kommen mit `xgettext` in `po/mailcraft-spam-ai.pot`.

## Lizenz

GPL-3.0-or-later. Siehe [LICENSE](LICENSE).
