// Receiver-local execution consumption survives peer/grant removal. Never federated.
export const peerExecutionDdl = [
  `CREATE TABLE IF NOT EXISTS peer_execution_operations (
    operation_id UUID PRIMARY KEY,
    host_instance_id UUID NOT NULL,
    peer_instance_id UUID NOT NULL,
    request_id UUID NOT NULL,
    fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    binding JSONB NOT NULL,
    execution_epoch UUID NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'draining', 'in-flight', 'awaiting-reconnect', 'succeeded', 'failed', 'uncertain')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    claim JSONB,
    receipt JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (host_instance_id, peer_instance_id, request_id),
    CHECK (host_instance_id <> peer_instance_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_peer_execution_operations_state ON peer_execution_operations (state, operation_id)`,
  `CREATE TABLE IF NOT EXISTS peer_execution_generation_floors (
    host_instance_id UUID NOT NULL,
    peer_instance_id UUID NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('portos.update', 'portos.restart', 'catalog.install')),
    generation BIGINT NOT NULL CHECK (generation >= 0),
    PRIMARY KEY (host_instance_id, peer_instance_id, action),
    CHECK (host_instance_id <> peer_instance_id)
  )`,
];
