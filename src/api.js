const API_BASE = import.meta.env.VITE_API_BASE || '';

async function apiRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return data;
}

export const budgetApi = {
  bootstrap: () => apiRequest('/api/bootstrap'),
  login: (payload) => apiRequest('/api/auth/login', { method: 'POST', body: payload }),
  signup: (payload) => apiRequest('/api/auth/signup', { method: 'POST', body: payload }),
  googleAuth: (payload) => apiRequest('/api/auth/google', { method: 'POST', body: payload }),
  logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
  getInvite: (token) => apiRequest(`/api/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token) => apiRequest(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' }),
  createHousehold: (payload) => apiRequest('/api/households', { method: 'POST', body: payload }),
  renameHousehold: (id, payload) => apiRequest(`/api/households/${id}`, { method: 'PUT', body: payload }),
  switchHousehold: (householdId) => apiRequest('/api/households/active', { method: 'POST', body: { householdId } }),
  listHouseholdMembers: (id) => apiRequest(`/api/households/${id}/members`),
  createHouseholdInvite: (id, payload) => apiRequest(`/api/households/${id}/invites`, { method: 'POST', body: payload }),
  addHouseholdMember: (id, payload) => apiRequest(`/api/households/${id}/members`, { method: 'POST', body: payload }),
  leaveHousehold: (id) => apiRequest(`/api/households/${id}/leave`, { method: 'POST' }),
  archiveHousehold: (id, payload) => apiRequest(`/api/households/${id}/archive`, { method: 'POST', body: payload }),
  updateHouseholdMember: (id, payload) => apiRequest(`/api/household-members/${id}`, { method: 'PUT', body: payload }),
  removeHouseholdMember: (id) => apiRequest(`/api/household-members/${id}`, { method: 'DELETE' }),
  listAdminHouseholds: () => apiRequest('/api/admin/households'),
  restoreAdminHousehold: (id) => apiRequest(`/api/admin/households/${id}/restore`, { method: 'POST' }),
  listUsers: () => apiRequest('/api/users'),
  createUser: (payload) => apiRequest('/api/users', { method: 'POST', body: payload }),
  updateUser: (id, payload) => apiRequest(`/api/users/${id}`, { method: 'PUT', body: payload }),
  resetUserPassword: (id, password) => apiRequest(`/api/users/${id}/password`, { method: 'PUT', body: { password } }),
  deleteUser: (id) => apiRequest(`/api/users/${id}`, { method: 'DELETE' }),
  updateOwnProfile: (payload) => apiRequest('/api/users/me/profile', { method: 'PUT', body: payload }),
  updateOwnPassword: (payload) => apiRequest('/api/users/me/password', { method: 'PUT', body: payload }),
  getSettings: () => apiRequest('/api/settings'),
  updateSettings: (payload) => apiRequest('/api/settings', { method: 'PUT', body: payload }),
  createAccount: (payload) => apiRequest('/api/accounts', { method: 'POST', body: payload }),
  updateAccount: (id, payload) => apiRequest(`/api/accounts/${id}`, { method: 'PUT', body: payload }),
  deleteAccount: (id) => apiRequest(`/api/accounts/${id}`, { method: 'DELETE' }),
  createTransaction: (payload) => apiRequest('/api/transactions', { method: 'POST', body: payload }),
  createTransactionsBatch: (transactions) => apiRequest('/api/transactions/bulk', { method: 'POST', body: { transactions } }),
  updateTransaction: (id, payload) => apiRequest(`/api/transactions/${id}`, { method: 'PUT', body: payload }),
  deleteTransaction: (id) => apiRequest(`/api/transactions/${id}`, { method: 'DELETE' }),
  createRecurringRule: (payload) => apiRequest('/api/recurring-rules', { method: 'POST', body: payload }),
  updateRecurringRule: (id, payload) => apiRequest(`/api/recurring-rules/${id}`, { method: 'PUT', body: payload }),
  deleteRecurringRule: (id) => apiRequest(`/api/recurring-rules/${id}`, { method: 'DELETE' }),
  upsertRecurringOverride: (payload) => apiRequest('/api/recurring-overrides', { method: 'POST', body: payload }),
  deleteRecurringOverride: (id) => apiRequest(`/api/recurring-overrides/${id}`, { method: 'DELETE' }),
  createBudget: (payload) => apiRequest('/api/budgets', { method: 'POST', body: payload }),
  saveBudgetPlanner: (budgets) => apiRequest('/api/budgets/bulk', { method: 'POST', body: { budgets } }),
  updateBudget: (id, payload) => apiRequest(`/api/budgets/${id}`, { method: 'PUT', body: payload }),
  deleteBudget: (id) => apiRequest(`/api/budgets/${id}`, { method: 'DELETE' }),
  createReconciliation: (payload) => apiRequest('/api/reconciliations', { method: 'POST', body: payload }),
  deleteReconciliation: (id) => apiRequest(`/api/reconciliations/${id}`, { method: 'DELETE' }),
  createLoanPayment: (payload) => apiRequest('/api/loan-payments', { method: 'POST', body: payload }),
  updateLoanPayment: (id, payload) => apiRequest(`/api/loan-payments/${id}`, { method: 'PUT', body: payload }),
  deleteLoanPayment: (id) => apiRequest(`/api/loan-payments/${id}`, { method: 'DELETE' }),
  createLoanDraw: (payload) => apiRequest('/api/loan-draws', { method: 'POST', body: payload }),
  deleteLoanDraw: (id) => apiRequest(`/api/loan-draws/${id}`, { method: 'DELETE' }),
  getLegacyLoanState: () => apiRequest('/api/legacy-loans/state'),
};
