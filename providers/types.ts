// Общие типы для выхода моделей модерации.
// Формат зафиксирован в ARCHITECTURE.md §6 и един для всех провайдеров.

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type Verdict = 'approve' | 'needs_review' | 'reject';

export interface Violation {
  rule_id: string;
  severity: Severity;
  quote: string;
  confidence: number;
}

export interface ModerationResult {
  violations: Violation[];
  verdict: Verdict;
}
