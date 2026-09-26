CREATE TABLE IF NOT EXISTS hour_slots (
    slot_start TIMESTAMPTZ PRIMARY KEY,
    winner_message TEXT NOT NULL,
    attempt_count BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT hour_slots_attempt_count_check CHECK (attempt_count >= 1),
    CONSTRAINT hour_slots_winner_message_length_check CHECK (char_length(winner_message) BETWEEN 1 AND 120)
);
