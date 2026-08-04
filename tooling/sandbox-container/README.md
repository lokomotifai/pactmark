# Unsafe container isolation reference

This fixture is an executable Docker contract for local development and CI. It is **not** a production sandbox, certification, containment guarantee, or arbitrary-code isolation service.

The runner uses a non-root user, a read-only root filesystem, a fresh writable tmpfs workspace, no network, no host bind mounts, no Docker socket mount, dropped capabilities, `no-new-privileges`, and bounded process, memory, CPU, file-descriptor, time, and output limits. It probes representative host-path, traversal, symlink, Docker-socket, loopback, and metadata access attempts. Passing those probes only describes the exact tested image, Docker configuration, host, and attack corpus.

It does not prove resistance to kernel, container-runtime, CPU side-channel, filesystem, DNS, device, or future escape vulnerabilities. A production deployment that executes untrusted code needs a separately maintained isolation boundary, patched host/runtime, stronger policy and monitoring, and the exported `@pactmark/testing` enforcement contracts.

The canonical gate never contacts a registry and never pulls implicitly. Bootstrap and retain the exact digest-pinned base image once with the explicit networked command:

```sh
pnpm bootstrap:sandbox-container-base
```

Then run the conformance gate offline:

```sh
pnpm test:sandbox-container
```

The runner verifies that the local base has repository digest `node@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3` before an offline build. Missing or substituted base images fail closed; there is no hidden network fallback. Docker unavailability is a failure with `KAF_SANDBOX_CONTAINER_RUNTIME_UNAVAILABLE`; it is never reported as a passing skip. Successful output records both the base digest and local fixture-image digest and confirms that every temporary container and host canary was removed. Both images are retained locally for repeatable offline verification and digest inspection.
