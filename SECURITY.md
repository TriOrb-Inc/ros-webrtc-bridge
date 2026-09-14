# Security Policy

## Current status

This project is a connection proof of concept. It implements TLS, a single Bearer credential with explicit allowlists, and command ownership, lease, and sequence validation. There are no supported releases yet. Multi-user identity, token issuance and expiration management, and a safety assessment for public deployment remain incomplete.

The goal is a WebRTC Topic bridge that can reach a ROS 2 graph. The following are implementation and operational requirements; the specific guarantees are defined in [`docs/design.md`](docs/design.md).

## Connection and operation boundaries

- Protect signaling with HTTPS/WSS and associate SDP with the authenticated identity, robot, and session.
- Allowlist Topics, types, and directions. Do not infer publish permission from read permission. Filter the catalog by permissions too.
- Apply token expiration, session revocation, and ACL changes to existing DataChannels.
- Limit command writers targeting the same ROS output. Validate ownership, epoch, sequence, and lease both on receipt and immediately before ROS publication.
- Do not treat DTLS encryption alone as a guarantee of authorization or command freshness.

## Input, resources, and records

- Bound the size, count, rate, and processing time of messages, schemas, SDP, ICE candidates, and control requests.
- Keep queues, DataChannel send buffers, caches, and peer counts finite. A slow peer must not block other peers or ROS processing.
- Do not log payloads, authentication data, TURN credentials, or connection information from SDP/ICE by default. Limit audit records to authorization outcomes, rejection classifications, and similar metadata; define retention and access controls.
- Supply secrets through external configuration, never through repository files or examples. Remove confidential information before sharing diagnostics.
- With `ros2 launch`, inherit `BRIDGE_CREDENTIAL`, `BRIDGE_TLS_KEY`, and `BRIDGE_TLS_CERT` from the execution environment. Do not put Bearer credentials or TLS keys/certificates in launch arguments or command lines.

## Robot-side responsibilities

The Gateway validates deadlines up to the instant before ROS publication. If late delivery through DDS or controller queues must be rejected, use a command gate and deadline/generation data that the controller can validate. Provide a robot-side input watchdog and test disconnection, browser suspension, and Gateway shutdown.

Do not replay old commands on reconnection. A generic bridge must not guess a stop message. A successful ROS publication acknowledgement does not mean that the physical robot has completed an operation.

## Reporting vulnerabilities

Do not include details of unpatched vulnerabilities, reproduction secrets, or connection information in public issues or pull requests. Contact the maintainers privately.

A dedicated reporting address, the status of GitHub Private Vulnerability Reporting, and response deadlines have not yet been established. This document will list reporting contacts and supported versions before the first public release.
