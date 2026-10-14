import { opaqueSession, ProviderError } from './providers.mjs';
export function createShareEvents({ now, validSession, allowedOrigins, emit = () => { } }) {
    const tickets = new Map();
    let revision = 0;
    function issue(session) {
        for (const [id, t] of tickets)
            if (t.expiresAt <= now())
                tickets.delete(id);
        if (tickets.size >= 512 || [...tickets.values()].filter(t => t.session.accountId === session.accountId).length >= 4)
            throw new ProviderError('TOO_MANY_CONNECTIONS', 429);
        const ticket = opaqueSession();
        tickets.set(ticket, { session, expiresAt: now() + 30000 });
        return { ticket, expiresAt: now() + 30000 };
    }
    function consume(ticket, origin) {
        if (!allowedOrigins.has(origin))
            throw new ProviderError('ORIGIN_NOT_ALLOWED', 403);
        const t = tickets.get(ticket);
        if (!t || t.expiresAt <= now() || !validSession(t.session))
            throw new ProviderError('EVENT_TICKET_EXPIRED', 401);
        tickets.delete(ticket);
        return t.session;
    }
    function changed(accounts) {
        const value = { type: 'shares-changed', revision: ++revision };
        for (const account of new Set(accounts))
            emit(account, value);
    }
    return { issue, consume, changed };
}
