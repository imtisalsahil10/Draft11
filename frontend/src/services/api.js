/**
 * API SERVICE
 * HTTP calls to backend
 */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

class ApiService {
  async request(endpoint, options = {}) {
    const url = `${API_URL}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    return response.json();
  }

  // ROOM APIs
  async createRoom() {
    return this.request('/api/room/create', { method: 'POST' });
  }

  async getRoom(roomCode) {
    return this.request(`/api/room/${roomCode}`);
  }

  // CARD APIs
  async getCards() {
    return this.request('/api/cards');
  }

  async getLocalCatalogue() {
    return this.request('/api/local-catalogue');
  }

  // HEALTH CHECK
  async healthCheck() {
    return this.request('/health');
  }
}

export default new ApiService();
