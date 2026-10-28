# Set up the AI Coach with Google Gemini

This guide is for the person who owns an openGym server and wants its AI Coach to call the
[Gemini API](https://ai.google.dev/gemini-api/docs) (`generateContent`). It uses an API key and
a model id. It does not use the old Gemini CLI, and it does not run a browser login.

## Before you begin

You need:

- an openGym administrator profile;
- a stack built from this revision (`docker compose up -d --build`); and
- a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

The default model is `gemini-2.5-flash`. Set another id if your key uses a different one.
Confirm the id in Google's [model list](https://ai.google.dev/gemini-api/docs/models).

## Connect from the admin card

1. Open **Settings → Admin dashboard → AI Coach** and turn **AI Coach** on.
2. Under **Provider**, select **Google Gemini**.
3. **Runtime** should say `ready` and `Gemini API`. The client is part of the api process, so
   this does not depend on a separate binary.
4. Choose **Use an API key**, paste the key, and save.
5. Set **Model** if you do not want `gemini-2.5-flash`.
6. Select **Test the Coach**.

The key is encrypted in `./data/coach.json` and sent only as the `x-goog-api-key` header while
a job runs. It is not placed in the request URL.

## Connect from `.env`

Set variables override the card until you remove them and restart the api service. The key is
not copied into `coach.json`.

```bash
COACH_ENABLED=1
COACH_PROVIDER=gemini
COACH_GEMINI_API_KEY=your_key_here
COACH_GEMINI_MODEL=gemini-2.5-flash
```

`COACH_MODEL`, if set, wins over `COACH_GEMINI_MODEL`.

```bash
docker compose up -d
```

## What is sent

One `generateContent` request to
`https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`. The body is
the Coach prompt plus a system line that asks for JSON only. There are no tools. The same
allowlist used by the other providers decides which fields can leave the server.

The Coach stays off for a profile until that profile consents, and it never applies a change
by itself.

## Disconnect or rotate

- **Key saved in the card:** **Disconnect**, create a new key in AI Studio, and paste it.
- **Key set in `.env`:** replace `COACH_GEMINI_API_KEY` and restart the api service. Revoke the
  old key in AI Studio. The card will keep showing the environment key until the variable is
  gone.

## Troubleshooting

| What you see | What to do |
|---|---|
| Credential: needed | No key is saved and `COACH_GEMINI_API_KEY` is unset. |
| `API key not valid` | The key was revoked or copied with extra whitespace. Create another and replace it. |
| Model not found | Set `COACH_GEMINI_MODEL` or the card's model field to an id your key can call. |
| The provider did not answer in time | Retry. A long review is one request; the daily caps still apply. |
| A profile cannot see Coach | Enable the Coach, connect the key, and have that profile consent. |
| **Force-disabled by COACH_DISABLED** | Remove `COACH_DISABLED=1` and restart the api service. |

## Official references

- [Gemini API: API keys](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini API: generateContent](https://ai.google.dev/api/generate-content)
- [openGym self-hosting guide](docs/SELF_HOSTING.md#8-the-ai-coach-optional)
