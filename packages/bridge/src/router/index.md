# SessionRouter implementation

## Purpose

Consistently validate configuration, authorization, types, and delivery limits along the path from wire operations to logical ROS listeners and publication.

## Scope

Owns one peer's session and delegates publisher leases to a CommandGuard shared by all peers. Creating native ROS entities and transport connections is outside its scope.

## Current behavior

Implements hello, subscribe/ready, advertise/arm, publish, removal operations, and finite queues/caches. See the [README](README.md) for interfaces.

## Implementation decisions

Publication does not cross an asynchronous wait. The codec and authorization are re-evaluated immediately before the synchronous ROS call. A control-priority queue retains its head when sending is refused. Registering a subscription listener does not make it ready; synchronously delivered initial samples are discarded too. The request cache prevents repeated side effects from retransmission within its lifetime.

`isClosed` becomes true when closure starts. An optional `onClosed` is notified once after all resources are cleaned up. The Endpoint schedules PeerConnection closure in a microtask, so a router closure originating from a ROS callback also releases the process's peer registration.

## Goals

Validate module boundaries through real ROS/browser connections, a request-retry SDK, process-wide budgets, and fault injection.

## Related documentation

[Design](../../../../docs/design.md), [session core](../session/README.md), [codec](../codec/README.md).
