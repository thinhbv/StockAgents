/**
 * Tên sự kiện phát ra qua event_log. Phase 4 (dashboard SSE) đọc đúng
 * những tên này, nên chúng là hợp đồng, không phải chuỗi tùy hứng.
 */
export const EVENTS = Object.freeze({
  SESSION_STATE: 'session.state',
  AGENT_STARTED: 'agent.started',
  AGENT_DECIDED: 'agent.decided',
  AGENT_SKIPPED: 'agent.skipped',
  ORDER_PLACED: 'order.placed',
  ORDER_FILLED: 'order.filled',
  ORDER_REJECTED: 'order.rejected',
  TRIGGER_FIRED: 'trigger.fired',
  POSITION_MARKED: 'position.marked',
  METRICS_UPDATED: 'metrics.updated',
});
