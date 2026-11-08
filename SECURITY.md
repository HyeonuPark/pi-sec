# Security

## Security model

- pi-sec can do everything that the Linux account that runs it can do. This is intended.
- The only gate is access to the web server of the daemon. A person who can reach that server can direct the agent.
- The threat is a person without permission who reaches that server.
- pi-sec does not stop that person. You stop that access with tools outside pi-sec, for example an authenticating reverse proxy, or a host where only localhost reaches the daemon.

Other accounts on the same host can reach a loopback port. On a host that has such accounts, block them with an outside tool or trust them.

The Host and Origin checks of the daemon make it harder for other pages in a browser to reach the server. They do not replace the outside access control.

## Deployment

Bind the daemon to a loopback address, or put it behind a reverse proxy that authenticates. If the browser reaches the daemon through another name or port, set `server.publicUrl` to that address.

See [docs/security.md](docs/security.md) for the full model, the access premise, and the threat table.
