# Notice

MailCraft Spam AI is based on the spam filter of **ThunderAI** by Mic (micz),
https://micz.it/thunderbird-addon-thunderai/, licensed under the GNU General Public License
version 3. The analysis was done against ThunderAI 5.2.0.

Taken over:

- the spam filter prompt (`prompt_spamfilter_full_text`) and its answer format,
  `{"explanation", "spamValue"}` with a value from 0 to 100;
- the threshold, with 70 as default and a warning for very low values;
- the skip list of addresses and whole domains;
- never moving a message when anything fails, and moving messages one at a time.

Changed:

- the model gets the mail as plain text shortened to a set length, not the raw HTML source;
- the answer is forced into a JSON schema, with temperature 0 and, for Ollama, a context length
  that holds the whole prompt;
- the prompt also carries MailCraft's sender warnings and the SPF, DKIM and DMARC results, and
  says that the mail is data, not instructions;
- there is no block list of its own: MailCraft's Blocked Senders already does that.

MailCraft Spam AI is not affiliated with MailCraft or ThunderAI.
