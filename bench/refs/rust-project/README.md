# rust-project reference subset

Subset of [github.com/tokio-rs/tokio](https://github.com/tokio-rs/tokio) at commit
`6c03e03898d71eca976ee1ad8481cf112ae722ba`, included for benchmark reproducibility.

31 Rust source files sampled from `tokio/src/` covering:
filesystem abstractions (fs/), future combinators (future/), async I/O traits
and implementations (io/), and utility types (buf_reader, buf_writer, chain, etc.).

No test files are included. Files under `tests/` were excluded.

## License notice

The files in `tokio/` are copyright Tokio contributors, licensed under the MIT
License. See https://github.com/tokio-rs/tokio/blob/master/LICENSE for the full
text. These files are included here solely for benchmark reproducibility under
the MIT License terms.
