import type { Contractor, ContractorProposal } from '../types.js';
const AVAILABLE = /^(available|immediate|today|now|available today|available now)$/i;
const TRADE_RULES: { trade: string; pattern: RegExp }[] = [
    { trade: 'plumbing', pattern: /\b(sink|leak|drip(?:ping)?|pipe|tap|toilet|drain|plumb\w*|waste)\b/i },
    { trade: 'electrical', pattern: /\b(electric\w*|socket|wiring|fuse)\b/i },
    { trade: 'heating', pattern: /\b(boiler|heating|radiator)\b/i },
    { trade: 'locksmith', pattern: /\b(locksmith|lock|keys?)\b/i },
    { trade: 'glazing', pattern: /\b(glazing|window|glass)\b/i },
];
export function explicitlyAvailable(availability: string): boolean { return AVAILABLE.test(availability.trim()); }
export function proposalFrom(contractor: Contractor): ContractorProposal {
    return { id: contractor.id, name: contractor.name, trade: contractor.trade, rating: contractor.rating, directoryAvailability: contractor.availability };
}
export function inferTrade(text: string, contractors: Contractor[]): string | undefined {
    const scores = new Map<string, number>();
    const trades = [...new Set(contractors.map(c => c.trade))];
    for (const trade of trades) {
        const rule = TRADE_RULES.find(item => item.trade === trade.toLowerCase() || trade.toLowerCase().includes(item.trade));
        const hits = rule ? text.match(new RegExp(rule.pattern.source, 'gi'))?.length ?? 0 : 0;
        const named = text.toLowerCase().includes(trade.toLowerCase()) ? 5 : 0;
        if (hits || named)
            scores.set(trade, hits + named);
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}
/** Exact trade, explicitly current availability, then higher rating, then stable id. */
export function selectContractor(contractors: Contractor[], trade: string, excluded: readonly string[]): Contractor | undefined {
    return contractors.filter(c => c.trade.toLowerCase() === trade.toLowerCase() && !excluded.includes(c.id) && explicitlyAvailable(c.availability)).sort((a, b) => b.rating - a.rating || a.id.localeCompare(b.id))[0];
}
