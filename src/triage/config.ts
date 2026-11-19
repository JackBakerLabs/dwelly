import type { ModelOptions } from './index.js';

export function modelConfiguration(env: NodeJS.ProcessEnv = process.env): ModelOptions & { provider: 'openai' | 'openrouter'; model: string } {
    const provider = env.MODEL_PROVIDER ?? (env.OPENROUTER_API_KEY && !env.OPENAI_API_KEY ? 'openrouter' : 'openai');
    if (provider !== 'openai' && provider !== 'openrouter') throw new Error('MODEL_PROVIDER must be openai or openrouter');
    const keyName = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
    const apiKey = env[keyName];
    if (!apiKey?.trim()) throw new Error(`Missing ${keyName}. See README.md for configuration.`);
    const model = provider === 'openrouter' ? env.OPENROUTER_MODEL : env.OPENAI_MODEL ?? 'gpt-4.1-mini';
    if (!model?.trim()) throw new Error('Set OPENROUTER_MODEL to the model ID you want to evaluate.');
    return { apiKey, provider, model };
}
