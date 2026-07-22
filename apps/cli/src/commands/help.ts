export const helpText = `Nusend CLI

Usage:
  nusend [--base-url <url>] [--json] <command>

Commands:
  login <base-url> [--name <client-name>] [--permission resource:action ...]
  logout [--revoke]
  whoami
  api-keys list [--limit <n>] [--offset <n>]
  api-keys create --name <name> --permission resource:action ... [--expires-at <iso> | --no-expiry]
  api-keys revoke <id>
  api-keys rotate <id>
  contacts list [--email <email>] [--limit <n>] [--offset <n>]
  contacts get <id>
  contacts create <email>
  contacts update <id> <email>
  contacts delete <id>
  mailings list [--limit <n>] [--offset <n>]
  mailings get <id>
  mailings create --file <path|-> [--idempotency-key <key>]
  lists list [--limit <n>] [--offset <n>]
  lists get <id>
  lists create <name>
  lists update <id> <name>
  lists delete <id>
  lists contacts list <list-id> [--email <email>] [--status <all|subscribed|unsubscribed>] [--limit <n>] [--offset <n>]
  lists contacts import <list-id> --file <path|->
  lists contacts remove <list-id> <contact-id>
  suppressions list [--email <email>] [--scope <all|marketing|list>] [--reason <bounce|complaint|manual|unsubscribe>] [--list-id <id>] [--limit <n>] [--offset <n>]
  suppressions create <email> --scope <all|marketing|list> [--list-id <id>]
  suppressions delete <id>
  operations summary
  deliveries list [--email <email>] [--issue <failed_or_ambiguous>] [--limit <n>] [--mailing-id <id>] [--ses-message-id <id>] [--status <queued|sending|sent|failed|suppressed|ambiguous>]
  deliveries get <id>
  ses summary
  ses readiness [--no-aws]
  ses setup-guide [--no-aws]
  ses events list [--delivery-id <id>] [--email <email>] [--event-type <type>] [--limit <n>] [--mailing-id <id>] [--offset <n>] [--ses-message-id <id>]
  ses events get <id>
  ses simulator-runs list
  ses simulator-runs get <id>
  config repair-permissions

Global:
  --help, -h       Show help
  --version, -v    Show version
  --json           Print stable JSON output
`;
