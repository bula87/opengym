# Set up the AI Coach with an OpenAI-compatible API

This guide is for the person who owns an openGym server and wants its AI Coach to call any
server that implements `POST /chat/completions` the way the OpenAI API does. That includes:

| Server | Base URL | API key | Example model |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | required | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | required | `openai/gpt-4o-mini` |
| Ollama on the Docker host | `http://host.docker.internal:11434/v1` | omit | `llama3.1` |
| LM Studio on the Docker host | `http://host.docker.internal:1234/v1` | omit, or any placeholder the server accepts | the id LM Studio shows |
| vLLM | `http://host.docker.internal:8000/v1` | whatever that server requires | the id from `/v1/models` |

`host.docker.internal` is added by `docker-compose.yml` and points at the machine running
Docker. From inside the api container, `localhost` is the container itself, not your host.

The base URL is the API root, not the full completions path. A trailing slash, or a pasted
`/chat/completions`, is stripped. The URL must be `http` or `https` and must not contain a
username or password — put the key in the API key field.

## Before you begin

You need an openGym administrator profile and a rebuilt stack (`docker compose up -d --build`)
so the admin card knows this provider. No extra package is installed for it: the api process
makes one HTTPS (or HTTP) request per job.

## Connect from the admin card

1. Open **Settings → Admin dashboard → AI Coach** and turn **AI Coach** on.
2. Under **Provider**, select **OpenAI-compatible**.
3. Set **API base URL**.
4. Set **Model**, or leave it blank to use `gpt-4o-mini`.
5. If the server requires a key, choose **Set API key** and paste it. Local servers that ignore
   `Authorization` can stay without one; the credential then reads as not required.
6. Select **Test the Coach**.

A saved key is encrypted in `./data/coach.json` and sent only as `Authorization: Bearer …`
while a job runs. It is never put in the URL and never shown again.

## Connect from `.env`

Set variables override the admin card until they are removed and the api service is restarted.
A key set here is not written into `coach.json`.

```bash
COACH_ENABLED=1
COACH_PROVIDER=openai
COACH_OPENAI_BASE_URL=https://api.openai.com/v1
COACH_OPENAI_API_KEY=sk-...
COACH_OPENAI_MODEL=gpt-4o-mini
```

Ollama on the host, no key:

```bash
COACH_ENABLED=1
COACH_PROVIDER=openai
COACH_OPENAI_BASE_URL=http://host.docker.internal:11434/v1
COACH_OPENAI_MODEL=llama3.1
```

`COACH_MODEL`, if set, wins over `COACH_OPENAI_MODEL`.

```bash
docker compose up -d
```

## What is sent

One chat-completions request: a short system line telling the model to return JSON, and the
Coach prompt as the user message. There are no tools. The payload is the same allowlist the
other providers use (plan, training window, intake, body weight, unit and language).

The Coach is optional for every profile. It proposes changes and does not apply them.

## Disconnect or rotate

- **Key saved in the card:** **Disconnect**, then set a new one.
- **Key or URL set in `.env`:** the card locks that field and says it comes from the
  environment. Edit `.env` and restart the api service. Clear the URL variable to go back to
  choosing it in the card.

## Troubleshooting

| What you see | What to do |
|---|---|
| Runtime says to set a base URL | The provider is selected but no URL is saved and `COACH_OPENAI_BASE_URL` is unset. |
| Connection refused | The URL points at the container's localhost, or the server is down. Use `host.docker.internal` and the host port. |
| `HTTP 401` or `HTTP 403` | The server wants a key, or the key is wrong. |
| The answer was not JSON | The model ignored the prompt. Try a stronger model, or ask again — one repair round runs automatically on real Coach jobs. |
| A profile cannot see Coach | Enable the provider, set a base URL, and have that profile consent. |

## References

- [OpenAI: chat completions](https://platform.openai.com/docs/api-reference/chat)
- [Ollama: OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/openai.md)
- [openGym self-hosting guide](docs/SELF_HOSTING.md#8-the-ai-coach-optional)
