-- Legacy rounds only carry percentages (no hit/possible counts) and a Drive image reference.
alter table rounds
  add column fir_pct numeric check (fir_pct between 0 and 1),
  add column gir_pct numeric check (gir_pct between 0 and 1),
  add column scrambling_pct numeric check (scrambling_pct between 0 and 1),
  add column legacy jsonb;

comment on column rounds.fir_pct is 'Used when fir_hit/fir_possible are unknown (legacy OCR rounds)';
