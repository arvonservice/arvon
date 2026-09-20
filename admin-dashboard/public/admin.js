async function adminLogin() {
  const password = document.getElementById('passwordInput').value.trim();
  if (!password) return alert('Entrez le mot de passe');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    if (!res.ok) {
      const err = await res.json();
      return alert('Mot de passe incorrect: ' + (err.error || 'Erreur'));
    }

    document.getElementById('loginContainer').style.display = 'none';
    document.getElementById('dashboardContainer').classList.add('active');
    loadDashboard();
  } catch (e) {
    alert('Erreur: ' + e.message);
  }
}

async function adminLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
    document.getElementById('loginContainer').style.display = 'flex';
    document.getElementById('dashboardContainer').classList.remove('active');
    document.getElementById('passwordInput').value = '';
  } catch (e) {
    alert('Erreur: ' + e.message);
  }
}

function switchSection(section) {
  document.querySelectorAll('.tournaments-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  if (section === 'dashboard') {
    document.getElementById('dashboardSection').classList.add('active');
    document.querySelector('[onclick="switchSection(\'dashboard\')"]').classList.add('active');
    loadDashboard();
  } else if (section === 'tournaments') {
    document.getElementById('tournamentsSection').classList.add('active');
    document.querySelector('[onclick="switchSection(\'tournaments\')"]').classList.add('active');
    loadTournaments();
  }
}

function toggleCreateForm() {
  document.getElementById('createForm').classList.toggle('active');
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/tournaments');
    const tournaments = await res.json();
    const active = tournaments.filter(t => t.status === 'active').length;

    document.getElementById('statTourneys').textContent = tournaments.length;
    document.getElementById('statActive').textContent = active;
    document.getElementById('statUsers').textContent = '2+';
  } catch (e) {
    console.error('Erreur:', e);
  }
}

async function loadTournaments() {
  try {
    const res = await fetch('/api/tournaments');
    const tournaments = await res.json();

    if (tournaments.length === 0) {
      document.getElementById('tournamentsList').innerHTML = '<div class="empty-state"><p>Aucun tournoi créé</p></div>';
      return;
    }

    const html = tournaments.map(t => `
      <div class="tournament-item">
        <div class="tournament-info">
          <h3>${t.name}</h3>
          <p>${t.description}</p>
          <p style="margin-top: 8px;"><strong>Mode:</strong> ${t.mode} · <strong>Participants:</strong> ${t.participants.length}/${t.maxParticipants} · <strong>Prize:</strong> $${t.prizePool} · <strong>Status:</strong> ${t.status}</p>
        </div>
        <div class="tournament-actions">
          <button class="btn-small" onclick="updateStatus(${t.id}, 'active')">Activer</button>
          <button class="btn-small" onclick="updateStatus(${t.id}, 'ended')">Terminer</button>
          <button class="btn-small btn-delete" onclick="deleteTournamentConfirm(${t.id})">Supprimer</button>
        </div>
      </div>
    `).join('');
    document.getElementById('tournamentsList').innerHTML = html;
  } catch (e) {
    console.error('Erreur:', e);
  }
}

async function createTournament() {
  const name = document.getElementById('tourneyName').value.trim();
  const description = document.getElementById('tourneyDesc').value.trim();
  const mode = document.getElementById('tourneyMode').value;
  const maxParticipants = parseInt(document.getElementById('tourneyMax').value) || 10;
  const prizePool = parseInt(document.getElementById('tourneyPrize').value) || 0;

  if (!name || !description) return alert('Remplissez tous les champs obligatoires');
  if (maxParticipants < 2) return alert('Min 2 participants');

  try {
    const res = await fetch('/api/tournaments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, mode, maxParticipants, prizePool })
    });

    if (!res.ok) {
      const err = await res.json();
      return alert('Erreur: ' + (err.error || 'Failed'));
    }

    document.getElementById('tourneyName').value = '';
    document.getElementById('tourneyDesc').value = '';
    document.getElementById('tourneyMax').value = '16';
    document.getElementById('tourneyPrize').value = '10000';
    document.getElementById('tourneyDate').value = '';
    toggleCreateForm();
    alert('✅ Tournoi créé!');
    loadTournaments();
  } catch (e) {
    alert('❌ Erreur: ' + e.message);
  }
}

async function updateStatus(id, status) {
  try {
    const res = await fetch(`/api/tournaments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });

    if (!res.ok) throw new Error('Failed');
    loadTournaments();
  } catch (e) {
    alert('Erreur: ' + e.message);
  }
}

function deleteTournamentConfirm(id) {
  if (!confirm('Supprimer ce tournoi?')) return;
  deleteTournament(id);
}

async function deleteTournament(id) {
  try {
    const res = await fetch(`/api/tournaments/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed');
    loadTournaments();
  } catch (e) {
    alert('Erreur: ' + e.message);
  }
}
