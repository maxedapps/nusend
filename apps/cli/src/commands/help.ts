export const helpText = `Nusend CLI

Usage:
  nusend [--profile <name>] [--base-url <url>] [--json] <command>

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
  config repair-permissions

Global:
  --help, -h       Show help
  --version, -v    Show version
  --json           Print stable JSON output
`;
