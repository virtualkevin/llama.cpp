<script lang="ts">
	import { Check, ChevronDown, Lightbulb, LightbulbOff } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { buttonVariants } from '$lib/components/ui/button';
	import { cn } from '$lib/components/ui/utils';
	import { useReasoningMenu } from '$lib/hooks/use-reasoning-menu.svelte';

	interface Props {
		disabled?: boolean;
	}

	let { disabled = false }: Props = $props();
	const reasoning = useReasoningMenu();
</script>

{#if reasoning.modelSupportsThinking}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			class={cn(
				buttonVariants({ variant: 'secondary' }),
				'h-8 cursor-pointer rounded-full px-2.5 text-xs'
			)}
			{disabled}
			title="Reasoning effort"
		>
			{#if reasoning.isOff}
				<LightbulbOff class="h-4 w-4 text-muted-foreground" />
			{:else}
				<Lightbulb
					class="h-4 w-4 {reasoning.thinkingEnabled ? 'text-amber-400' : 'text-muted-foreground'}"
				/>
			{/if}

			<span class="capitalize">{reasoning.currentEffort}</span>
			<ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
		</DropdownMenu.Trigger>

		<DropdownMenu.Content align="start" class="w-60">
			<DropdownMenu.Label>Reasoning effort</DropdownMenu.Label>
			{#each reasoning.levels as level (level.value)}
				{@const tokenLabel = reasoning.tokenLabel(level)}
				<DropdownMenu.Item
					class="flex cursor-pointer items-center gap-3"
					onclick={() => reasoning.select(level)}
				>
					{#if reasoning.isSelected(level)}
						<Check class="h-4 w-4 shrink-0" />
					{:else}
						<div class="h-4 w-4 shrink-0"></div>
					{/if}

					<span class="flex-1">{level.label}</span>
					{#if tokenLabel}
						<span class="text-[11px] text-muted-foreground">{tokenLabel}</span>
					{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
