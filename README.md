# autobee

Unstoppable, scalable multiwriter Hyperbee.

> **Still experimental and under heavy development. Expect breaking changes.**

```sh
npm install autobee
```

Multiple peers each write to their own local Hypercore. An `apply` function you provide merges those writes into a shared Hyperbee view deterministically. The view is consistent across all peers once they replicate.

## Documentation

New to Autobee? Start here:

- [How it Works](docs/01-concepts.md) — mental model, architecture, convergence
- [Quick Start](docs/02-quick-start.md) — install, single writer, multiple writers, replication

Detailed guides:

- [Writer Management](docs/03-writer-management.md) — adding, removing, and managing writers
- [The Apply Function](docs/04-apply-function.md) — the heart of Autobee, patterns and pitfalls
- [Optimistic Writes](docs/05-optimistic-writes.md) — writing before being confirmed as a writer
- [Custom Views](docs/06-custom-views.md) — the `open` and `update` callbacks
- [Replication](docs/07-replication.md) — syncing peers over the network with Hyperswarm
- [Events](docs/08-events.md) — full event reference
- [Interrupts](docs/09-interrupts.md) — pausing apply to fetch external data
- [Testing](docs/10-testing.md) — patterns for testing Autobee applications
- [API Reference](docs/11-api-reference.md) — complete API organized by group

## License

Apache-2.0
