/**
 * Estimates the number of tokens in a string using the ~4 chars/token approximation
 * commonly used for GPT-family models.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Wraps a tool response with the estimated token count appended as a footer.
 */
export function ok(text: string): { content: { type: 'text'; text: string }[] } {
    const tokens = estimateTokens(text);
    return {
        content: [{
            type: 'text' as const,
            text: `${text}\n\n---\n_~${tokens} tokens_`,
        }],
    };
}
