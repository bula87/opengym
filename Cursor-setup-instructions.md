# Set up the AI Coach with Cursor Agent

This guide is for the person who owns an openGym server and wants to run its AI Coach with
[Cursor](https://cursor.com) through the **Cursor Agent CLI** that is built into the api image.
It uses an API key, not a browser login inside the container.

Use this only on a server you control. The key is a credential for your Cursor account. Treat
`.env`, the admin card, and backups of `./data` the way you would treat a password.

## Before you begin

You need:

- a current openGym deployment built from this source revision (`docker compose up -d --build`
  so the image contains the Cursor CLI);
- an openGym administrator profile; and
- a Cursor account that can create an API key.

Create the key from [Cursor Dashboard → API Keys](https://cursor.com/dashboard). Cursor documents
the same key for headless use in its [CLI authentication guide](https://cursor.com/docs/cli/reference/authentication).

## Connect from the admin card

1. Sign in to openGym and open **Settings → Admin dashboard → AI Coach**.
2. Turn on **AI Coach**.
3. Under **Provider**, select **Cursor Agent**.
4. Confirm that **Runtime** says `ready` and names a Cursor CLI version. If it says `missing`,
   rebuild with `docker compose up -d --build`.
5. Under **Credential**, choose **Use an API key**, paste the key, and save.
6. Leave **Model** blank to use Cursor's default, or set one your account can use.
7. Select **Test the Coach**. A green result means the CLI returned the expected JSON, not only
   that the binary is installed.

The key is stored encrypted in `./data/coach.json` (using the instance secret) and is passed to
the CLI as `CURSOR_API_KEY` only while a job runs. It is not shown again.

## Connect from `.env`

The same settings can live in `.env`. When they are set, they override the admin card until you
remove them and restart the api service. The key is not copied into `coach.json`.

```bash
COACH_ENABLED=1
COACH_PROVIDER=cursor
COACH_CURSOR_API_KEY=your_key_here
# COACH_CURSOR_MODEL=composer-2
```

Then:

```bash
docker compose up -d
```

`COACH_MODEL` sets the model for whichever provider is selected and overrides
`COACH_CURSOR_MODEL`.

## What the job is allowed to do

Coach jobs run as the unprivileged `coach` user, in an empty temporary directory, in Cursor's
read-only **ask** mode. The prompt is written to a file in that directory rather than placed on
the command line. The CLI is started with `--disable-auto-update` and without `--force`, so it
is not asked to edit the workspace or upgrade itself. It still needs network access to reach
Cursor.

## Use the Coach safely

Set a **Per user / day** limit and, for a shared instance, a non-zero **Whole instance / day**
limit before enabling it for other profiles. Each plan, revision and review spends your Cursor
allowance.

Each profile must consent before its training data is sent. The Coach proposes changes; it never
applies them on its own.

## Disconnect or rotate

- **Key saved in the admin card:** choose **Disconnect**, then paste a new key.
- **Key set in `.env`:** the card shows the credential as coming from the environment.
  Disconnect does not unset it. Replace `COACH_CURSOR_API_KEY` and restart the api service.
  Revoke the old key in the Cursor dashboard.

## Troubleshooting

| What you see | What to do |
|---|---|
| `Runtime: missing` | Rebuild the api image (`docker compose up -d --build`) so `agent` is on the image `PATH`. |
| Test failed, unauthorized / API key | Create a new key, confirm it is the value in the card or `COACH_CURSOR_API_KEY`, and try again. |
| The provider did not answer in time | Cursor's agent round-trip can be slow. Retry once. If it keeps happening, set a model your account can actually run. |
| A profile cannot see Coach | The card must be enabled and connected, and that profile must consent in its Coach area. |
| **Force-disabled by COACH_DISABLED** | Remove `COACH_DISABLED=1` and restart the api service. |

## Official references

- [Cursor: CLI authentication](https://cursor.com/docs/cli/reference/authentication)
- [Cursor: headless CLI](https://cursor.com/docs/cli/headless)
- [openGym self-hosting guide](docs/SELF_HOSTING.md#8-the-ai-coach-optional)
