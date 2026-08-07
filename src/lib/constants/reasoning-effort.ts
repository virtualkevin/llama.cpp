import { ReasoningEffort } from '$lib/enums';
import type { ReasoningEffortLevel } from '$lib/types';

/**
 * Reasoning effort UI labels.
 * Keys match the ReasoningEffort enum values for type-safe lookups.
 */
export const REASONING_EFFORT_LABELS: Record<string, string> = {
	[ReasoningEffort.DEFAULT]: 'Default',
	[ReasoningEffort.OFF]: 'Off',
	[ReasoningEffort.MINIMAL]: 'Minimal',
	[ReasoningEffort.LOW]: 'Low',
	[ReasoningEffort.MEDIUM]: 'Medium',
	[ReasoningEffort.HIGH]: 'High',
	[ReasoningEffort.XHIGH]: 'Extra high',
	[ReasoningEffort.MAX]: 'Max'
};

export const REASONING_EFFORT_LEVELS: ReasoningEffortLevel[] = [
	{ value: ReasoningEffort.DEFAULT, label: 'Default', description: 'Model default' },
	{ value: ReasoningEffort.OFF, label: 'Off', description: 'No reasoning' },
	{ value: ReasoningEffort.MINIMAL, label: 'Minimal', description: 'Fastest reasoning' },
	{ value: ReasoningEffort.LOW, label: 'Low', description: 'Less reasoning' },
	{ value: ReasoningEffort.MEDIUM, label: 'Medium', description: 'Balanced' },
	{ value: ReasoningEffort.HIGH, label: 'High', description: 'More reasoning' },
	{ value: ReasoningEffort.XHIGH, label: 'Extra high', description: 'Extended reasoning' },
	{ value: ReasoningEffort.MAX, label: 'Max', description: 'DeepSeek V4 maximum', hasInfo: true }
];
