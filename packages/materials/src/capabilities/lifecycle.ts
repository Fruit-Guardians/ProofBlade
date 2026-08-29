import { canonicalJson, sha256 } from "../domain/utils.js";
import type { Scope, Disposable } from "../runtime/scope.js";

export type CapabilityAvailability = "REGISTERED" | "AVAILABLE" | "QUIESCING" | "UNAVAILABLE" | "UNREGISTERED";

export interface CapabilityDefinition {
  capabilityId: string;
  version: string;
  description: string;
  contractHash: string;
  capabilities: string[];
}

export interface CapabilityProviderRegistration {
  definition: CapabilityDefinition;
  providerId: string;
  providerVersion: string;
  registrationId: string;
  scopeId: string;
  priority: number;
  capabilities: string[];
  availability: CapabilityAvailability;
}

export interface CapabilityBinding {
  bindingId: string;
  capabilityId: string;
  consumerId: string;
  providerId: string;
  providerVersion: string;
  registrationId: string;
  scopeId: string;
}

export interface CapabilityConsumer {
  consumerId: string;
  capabilityId: string;
  scopeId: string;
  status: "ACTIVE" | "TEARING_DOWN" | "RELEASED";
  bindingId?: string;
}

export type CapabilityLifecycleEvent =
  | { type: "registered"; registration: CapabilityProviderRegistration }
  | { type: "available" | "quiescing" | "unavailable" | "unregistered"; registrationIdentity: string }
  | { type: "bound"; binding: CapabilityBinding }
  | { type: "consumer_teardown_started" | "consumer_released"; consumerId: string; bindingId?: string }
  | { type: "consumer_teardown_failed"; consumerId: string; bindingId?: string; error: string };

export type CapabilityLifecycleListener = (event: CapabilityLifecycleEvent) => void;

interface RegistrationEntry extends CapabilityProviderRegistration {
  value: unknown;
  consumers: Set<string>;
}

interface ConsumerEntry extends CapabilityConsumer {
  teardown?: () => Promise<void> | void;
  teardownPromise?: Promise<void>;
}

/**
 * Runtime binding registry. It owns no durable facts: callers may project its
 * typed lifecycle events into the Run ControlStore if they need replay.
 */
export class CapabilityLifecycleRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>();
  private readonly registrations = new Map<string, RegistrationEntry>();
  private readonly consumers = new Map<string, ConsumerEntry>();
  private readonly bindings = new Map<string, CapabilityBinding>();
  private readonly listeners = new Set<CapabilityLifecycleListener>();

  public define(definition: CapabilityDefinition): void {
    validateDefinition(definition);
    const existing = this.definitions.get(definition.capabilityId);
    if (existing && canonicalJson(existing) !== canonicalJson(definition)) throw new Error(`Capability definition already differs: ${definition.capabilityId}`);
    this.definitions.set(definition.capabilityId, structuredClone(definition));
  }

  public register(input: Omit<CapabilityProviderRegistration, "availability"> & { availability?: CapabilityAvailability }, value: unknown, scope?: Scope): CapabilityProviderRegistration {
    const definition = this.definitions.get(input.definition.capabilityId) ?? input.definition;
    this.define(definition);
    const registration = { ...input, definition, availability: input.availability ?? "REGISTERED" as const };
    validateRegistration(registration);
    const identity = registrationIdentity(registration);
    if (this.registrations.has(identity)) throw new Error(`Capability registration already exists: ${identity}`);
    const entry: RegistrationEntry = { ...structuredClone(registration), value, consumers: new Set() };
    this.registrations.set(identity, entry);
    this.emit({ type: "registered", registration: publicRegistration(entry) });
    if (scope) scope.add(`capability:${identity}`, async () => {
      this.quiesce(identity);
      this.unregister(identity);
    });
    return publicRegistration(entry);
  }

  public subscribe(listener: CapabilityLifecycleListener): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  public markAvailable(identity: string): CapabilityProviderRegistration {
    const entry = this.requireRegistration(identity);
    if (entry.availability === "QUIESCING" || entry.availability === "UNREGISTERED") throw new Error(`Cannot make capability available from ${entry.availability}: ${identity}`);
    entry.availability = "AVAILABLE";
    this.emit({ type: "available", registrationIdentity: identity });
    return publicRegistration(entry);
  }

  public markUnavailable(identity: string): CapabilityProviderRegistration {
    const entry = this.requireRegistration(identity);
    if (entry.availability === "QUIESCING" || entry.availability === "UNREGISTERED") throw new Error(`Cannot make capability unavailable from ${entry.availability}: ${identity}`);
    entry.availability = "UNAVAILABLE";
    this.emit({ type: "unavailable", registrationIdentity: identity });
    return publicRegistration(entry);
  }

  public quiesce(identity: string): CapabilityProviderRegistration {
    const entry = this.requireRegistration(identity);
    if (entry.availability === "UNREGISTERED") throw new Error(`Capability is already unregistered: ${identity}`);
    entry.availability = "QUIESCING";
    this.emit({ type: "quiescing", registrationIdentity: identity });
    return publicRegistration(entry);
  }

  public registerConsumer(input: { consumerId: string; capabilityId: string; scopeId: string; teardown?: () => Promise<void> | void }, scope?: Scope): CapabilityConsumer {
    bounded(input.consumerId, "consumer id");
    bounded(input.capabilityId, "consumer capability id");
    bounded(input.scopeId, "consumer scope id");
    if (!this.definitions.has(input.capabilityId)) throw new Error(`Unknown capability definition: ${input.capabilityId}`);
    if (this.consumers.has(input.consumerId)) throw new Error(`Capability consumer already exists: ${input.consumerId}`);
    const consumer: ConsumerEntry = { consumerId: input.consumerId, capabilityId: input.capabilityId, scopeId: input.scopeId, status: "ACTIVE", teardown: input.teardown };
    this.consumers.set(consumer.consumerId, consumer);
    if (scope) scope.add(`consumer:${consumer.consumerId}`, () => this.releaseConsumer(consumer.consumerId));
    return publicConsumer(consumer);
  }

  public bind(consumerId: string, preferredRegistrationId?: string): CapabilityBinding {
    const consumer = this.consumers.get(consumerId);
    if (!consumer || consumer.status !== "ACTIVE") throw new Error(`Capability consumer is not active: ${consumerId}`);
    if (consumer.bindingId) throw new Error(`Capability consumer is already bound: ${consumerId}`);
    const candidates = [...this.registrations.values()]
      .filter((entry) => entry.definition.capabilityId === consumer.capabilityId && entry.availability === "AVAILABLE" && (preferredRegistrationId === undefined || entry.registrationId === preferredRegistrationId))
      .sort((left, right) => right.priority - left.priority || registrationIdentity(left).localeCompare(registrationIdentity(right)));
    const selected = candidates[0];
    if (!selected) throw new Error(`No available provider for capability: ${consumer.capabilityId}`);
    const binding = publicBinding({
      bindingId: `binding-${sha256(`${consumer.consumerId}:${registrationIdentity(selected)}`).slice(0, 32)}`,
      capabilityId: consumer.capabilityId,
      consumerId,
      providerId: selected.providerId,
      providerVersion: selected.providerVersion,
      registrationId: selected.registrationId,
      scopeId: selected.scopeId,
    });
    this.bindings.set(binding.bindingId, binding);
    selected.consumers.add(consumerId);
    consumer.bindingId = binding.bindingId;
    this.emit({ type: "bound", binding });
    return structuredClone(binding);
  }

  /** Existing bindings remain readable while their provider is quiescing. */
  public resolve<T>(binding: CapabilityBinding): T {
    const current = this.bindings.get(binding.bindingId);
    if (!current || canonicalJson(current) !== canonicalJson(binding)) throw new Error(`Unknown or stale capability binding: ${binding.bindingId}`);
    const entry = this.registrations.get(registrationIdentity(binding));
    if (!entry || entry.availability === "UNREGISTERED") throw new Error(`Capability binding is unregistered: ${binding.bindingId}`);
    return entry.value as T;
  }

  public async beginConsumerTeardown(consumerId: string): Promise<CapabilityConsumer> {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) throw new Error(`Unknown capability consumer: ${consumerId}`);
    if (consumer.status === "RELEASED") return publicConsumer(consumer);
    if (consumer.teardownPromise) {
      await consumer.teardownPromise;
      return publicConsumer(consumer);
    }
    consumer.status = "TEARING_DOWN";
    this.emit({ type: "consumer_teardown_started", consumerId, ...(consumer.bindingId ? { bindingId: consumer.bindingId } : {}) });
    const teardownPromise = Promise.resolve().then(() => consumer.teardown?.()).then(() => undefined);
    consumer.teardownPromise = teardownPromise;
    try {
      await teardownPromise;
    } catch (error) {
      consumer.status = "ACTIVE";
      this.emit({ type: "consumer_teardown_failed", consumerId, ...(consumer.bindingId ? { bindingId: consumer.bindingId } : {}), error: String(error).slice(0, 1_000) });
      throw error;
    } finally {
      consumer.teardownPromise = undefined;
    }
    return publicConsumer(consumer);
  }

  public async releaseConsumer(consumerId: string): Promise<void> {
    const consumer = this.consumers.get(consumerId);
    if (!consumer || consumer.status === "RELEASED") return;
    if (consumer.status === "ACTIVE" || consumer.teardownPromise) await this.beginConsumerTeardown(consumerId);
    const current = this.consumers.get(consumerId);
    if (!current || current.status === "RELEASED") return;
    if (current.bindingId) {
      const binding = this.bindings.get(current.bindingId);
      if (binding) {
        const entry = this.registrations.get(registrationIdentity(binding));
        entry?.consumers.delete(consumerId);
        this.bindings.delete(binding.bindingId);
      }
      current.bindingId = undefined;
    }
    current.status = "RELEASED";
    this.emit({ type: "consumer_released", consumerId });
  }

  public unregister(identity: string): void {
    const entry = this.requireRegistration(identity);
    if (entry.consumers.size > 0) throw new Error(`Cannot unregister capability with active consumers: ${identity}`);
    entry.availability = "UNREGISTERED";
    this.emit({ type: "unregistered", registrationIdentity: identity });
    this.registrations.delete(identity);
  }

  public registrationsSnapshot(): CapabilityProviderRegistration[] {
    return [...this.registrations.values()].map(publicRegistration).sort((left, right) => registrationIdentity(left).localeCompare(registrationIdentity(right)));
  }

  public consumersSnapshot(): CapabilityConsumer[] {
    return [...this.consumers.values()].map(publicConsumer).sort((left, right) => left.consumerId.localeCompare(right.consumerId));
  }

  public bindingsSnapshot(): CapabilityBinding[] {
    return [...this.bindings.values()].map((binding) => structuredClone(binding)).sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  }

  public snapshotHash(): string {
    return sha256(canonicalJson({ definitions: [...this.definitions.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)), registrations: this.registrationsSnapshot(), consumers: this.consumersSnapshot(), bindings: this.bindingsSnapshot() }));
  }

  private requireRegistration(identity: string): RegistrationEntry {
    const entry = this.registrations.get(identity);
    if (!entry) throw new Error(`Unknown capability registration: ${identity}`);
    return entry;
  }

  private emit(event: CapabilityLifecycleEvent): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)); } catch { /* lifecycle observers are best effort */ }
    }
  }
}

export function registrationIdentity(value: Pick<CapabilityProviderRegistration, "providerId" | "providerVersion" | "registrationId" | "scopeId">): string {
  return `${value.providerId}:${value.providerVersion}:${value.registrationId}:${value.scopeId}`;
}

function publicRegistration(entry: RegistrationEntry): CapabilityProviderRegistration {
  const { value: _value, consumers: _consumers, ...registration } = entry;
  return structuredClone(registration);
}

function publicBinding(binding: CapabilityBinding): CapabilityBinding {
  return structuredClone(binding);
}

function publicConsumer(consumer: ConsumerEntry): CapabilityConsumer {
  const { teardown: _teardown, teardownPromise: _teardownPromise, ...publicValue } = consumer;
  return structuredClone(publicValue);
}

function validateDefinition(definition: CapabilityDefinition): void {
  bounded(definition.capabilityId, "capability id");
  bounded(definition.version, "capability version");
  bounded(definition.description, "capability description", 1_000);
  if (!/^[a-f0-9]{64}$/i.test(definition.contractHash)) throw new Error("Capability contractHash must be sha256");
  boundedList(definition.capabilities, "capability declarations");
}

function validateRegistration(registration: CapabilityProviderRegistration): void {
  bounded(registration.providerId, "provider id");
  bounded(registration.providerVersion, "provider version");
  bounded(registration.registrationId, "registration id");
  bounded(registration.scopeId, "provider scope id");
  if (!Number.isInteger(registration.priority) || registration.priority < -1_000_000 || registration.priority > 1_000_000) throw new Error("Capability provider priority is invalid");
  boundedList(registration.capabilities, "provider capabilities");
}

function bounded(value: string, label: string, max = 256): void {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000\r\n]/.test(value)) throw new Error(`${label} is invalid`);
}

function boundedList(values: readonly string[], label: string): void {
  if (!Array.isArray(values) || values.length > 256 || values.some((value) => typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000\r\n]/.test(value))) throw new Error(`${label} are invalid`);
}
