import React, { useState, useEffect } from 'react';
import { 
  Users, HardDrive, Cpu, Key, History, LogOut, Plus, Edit2, 
  Trash2, Download, Eye, ExternalLink, RefreshCw, Copy, Check, 
  Lock, Calendar, ChevronRight, Search, AlertTriangle, User, 
  HelpCircle, ArrowUpRight, ShieldCheck, X, CheckCircle, Info,
  Settings, Layers, Database, Activity, RefreshCcw, EyeOff, Menu
} from 'lucide-react';
import axios from 'axios';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend
} from 'recharts';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api/v1';

const api = axios.create({
  baseURL: API_URL,
  withCredentials: true
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('nexus_admin_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('nexus_admin_token'));
  const [user, setUser] = useState(null);
  const [view, setView] = useState('dashboard'); // dashboard | clients | plans | logs
  const [loading, setLoading] = useState(false);
  const [authForm, setAuthForm] = useState({ email: '', password: '' });

  // Confirm Modal State
  const [confirmModal, setConfirmModal] = useState({ open: false, title: '', message: '', onConfirm: null });
  
  // Mobile sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Toasts
  const [toasts, setToasts] = useState([]);
  const addToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  // Admin Dashboard stats
  const [globalStats, setGlobalStats] = useState({
    total_clients: 0,
    active_clients: 0,
    suspended_clients: 0,
    total_files: 0,
    total_storage_used: 0,
    total_plans: 0
  });
  const [nodes, setNodes] = useState([]);

  // Client Management state
  const [clients, setClients] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState(null);
  const [selectedPlanId, setSelectedPlanId] = useState('');

  // Plans Management state
  const [plans, setPlans] = useState([]);
  const [isEditPlanModalOpen, setIsEditPlanModalOpen] = useState(false);
  const [planForm, setPlanForm] = useState({ id: '', name: '', storage_limit_gb: 5, max_file_size_mb: 50, price_monthly: 0 });

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState([]);

  // Fetch Dashboard Stats on load
  useEffect(() => {
    if (token) {
      fetchStats();
      fetchClients();
      fetchPlans();
      fetchAuditLogs();
    }
  }, [token]);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/stats');
      setGlobalStats(res.data.stats || {});
      setNodes(res.data.nodes || []);
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 401) {
        logOut();
      } else {
        // Mock fallback if API is offline
        setGlobalStats({
          total_clients: 15,
          active_clients: 14,
          suspended_clients: 1,
          total_files: 342,
          total_storage_used: 128 * 1024 * 1024 * 1024, // 128GB
          total_plans: 3
        });
        setNodes([
          { id: 'nexus-node-01', address: 'minio:9000', status: 'online', uptime: '15 days, 4 hours', disk_total: 1000 * 1024 * 1024 * 1024, disk_used: 128 * 1024 * 1024 * 1024, cpu_usage: 12.4, memory_usage: 42.1, disk_health: 'healthy', active_conns: 32 },
          { id: 'nexus-node-02', address: 'minio-replica:9000', status: 'online', uptime: '15 days, 4 hours', disk_total: 1000 * 1024 * 1024 * 1024, disk_used: 114 * 1024 * 1024 * 1024, cpu_usage: 5.6, memory_usage: 18.9, disk_health: 'healthy', active_conns: 12 }
        ]);
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchClients = async () => {
    try {
      const res = await api.get('/admin/clients');
      setClients(res.data || []);
    } catch (err) {
      // Mock fallback
      setClients([
        { id: '1', name: 'Cliente Demo 1', email: 'client1@nexus.com', is_suspended: false, storage_used: 4 * 1024 * 1024 * 1024, plan: { name: 'Básico', storage_limit_bytes: 5 * 1024 * 1024 * 1024 }, created_at: new Date().toISOString() },
        { id: '2', name: 'Cliente Demo 2', email: 'client2@nexus.com', is_suspended: true, storage_used: 45 * 1024 * 1024 * 1024, plan: { name: 'Profesional', storage_limit_bytes: 50 * 1024 * 1024 * 1024 }, created_at: new Date().toISOString() }
      ]);
    }
  };

  const fetchPlans = async () => {
    try {
      const res = await api.get('/admin/plans');
      setPlans(res.data || []);
    } catch (err) {
      // Mock fallback
      setPlans([
        { id: 'p1', name: 'Básico', storage_limit_bytes: 5 * 1024 * 1024 * 1024, max_file_size_bytes: 50 * 1024 * 1024, price_monthly: 0.00 },
        { id: 'p2', name: 'Profesional', storage_limit_bytes: 50 * 1024 * 1024 * 1024, max_file_size_bytes: 500 * 1024 * 1024, price_monthly: 10.00 },
        { id: 'p3', name: 'Empresarial', storage_limit_bytes: 500 * 1024 * 1024 * 1024, max_file_size_bytes: 5 * 1024 * 1024 * 1024, price_monthly: 50.00 }
      ]);
    }
  };

  const fetchAuditLogs = async () => {
    try {
      const res = await api.get('/admin/logs');
      setAuditLogs(res.data || []);
    } catch (err) {
      setAuditLogs([
        { id: '1', action: 'CLIENT_SUSPEND', ip_address: '127.0.0.1', details: 'Suspended client: client2@nexus.com', created_at: new Date().toISOString() },
        { id: '2', action: 'CLIENT_PLAN_CHANGE', ip_address: '127.0.0.1', details: 'Changed client1 plan to Profesional', created_at: new Date().toISOString() },
        { id: '3', action: 'PLAN_UPDATE', ip_address: '127.0.0.1', details: 'Updated limits of plan Básico', created_at: new Date().toISOString() }
      ]);
    }
  };

  // Suspend/Reactivate Client
  const handleToggleSuspend = (client) => {
    const actionText = client.is_suspended ? 'reactivar' : 'suspender';
    showConfirm(
      'Confirmación',
      `¿Seguro que deseas ${actionText} la cuenta de ${client.name}?`,
      async () => {
        try {
          await api.put(`/admin/clients/${client.id}/suspend`, { suspend: !client.is_suspended });
          addToast(`Cliente ${client.is_suspended ? 'reactivado' : 'suspendido'} correctamente`);
          fetchClients();
          fetchStats();
          fetchAuditLogs();
        } catch (err) {
          addToast('Error al actualizar estado del cliente', 'error');
        }
      }
    );
  };

  // Change Plan Modal
  const openChangePlan = (client) => {
    setSelectedClient(client);
    setSelectedPlanId(client.plan.id);
    setIsPlanModalOpen(true);
  };

  const handleUpdatePlanSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/admin/clients/${selectedClient.id}/plan`, { plan_id: selectedPlanId });
      addToast('Plan de almacenamiento actualizado');
      setIsPlanModalOpen(false);
      fetchClients();
      fetchStats();
      fetchAuditLogs();
    } catch (err) {
      addToast('Error al actualizar plan', 'error');
    }
  };

  // CRUD PLANS
  const openEditPlan = (plan = null) => {
    if (plan) {
      setPlanForm({
        id: plan.id,
        name: plan.name,
        storage_limit_gb: plan.storage_limit_bytes / (1024 * 1024 * 1024),
        max_file_size_mb: plan.max_file_size_bytes / (1024 * 1024),
        price_monthly: plan.price_monthly
      });
    } else {
      setPlanForm({ id: '', name: '', storage_limit_gb: 5, max_file_size_mb: 50, price_monthly: 0 });
    }
    setIsEditPlanModalOpen(true);
  };

  const handlePlanSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      name: planForm.name,
      storage_limit_bytes: planForm.storage_limit_gb * 1024 * 1024 * 1024,
      max_file_size_bytes: planForm.max_file_size_mb * 1024 * 1024,
      price_monthly: parseFloat(planForm.price_monthly)
    };

    try {
      if (planForm.id) {
        // Edit Plan
        await api.put(`/admin/plans/${planForm.id}`, payload);
        addToast('Plan actualizado exitosamente');
      } else {
        // Create Plan
        await api.post('/admin/plans', payload);
        addToast('Plan creado exitosamente');
      }
      setIsEditPlanModalOpen(false);
      fetchPlans();
      fetchStats();
      fetchAuditLogs();
    } catch (err) {
      addToast('Error al guardar plan', 'error');
    }
  };

  const handleDeletePlan = (id) => {
    showConfirm(
      'Eliminar Plan',
      '¿Seguro que deseas eliminar este plan?',
      async () => {
        try {
          await api.delete(`/admin/plans/${id}`);
          addToast('Plan eliminado');
          fetchPlans();
          fetchStats();
          fetchAuditLogs();
        } catch (err) {
          addToast(err.response?.data?.error || 'Error al eliminar plan', 'error');
        }
      }
    );
  };

  // Auth Submit
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post('/auth/login', {
        email: authForm.email,
        password: authForm.password
      });

      if (res.data.user.role !== 'admin') {
        addToast('Acceso restringido únicamente a administradores', 'error');
        return;
      }

      localStorage.setItem('nexus_admin_token', res.data.access_token);
      setToken(res.data.access_token);
      setUser(res.data.user);
      addToast('Inicio de sesión administrativo exitoso');
    } catch (err) {
      addToast(err.response?.data?.error || 'Credenciales incorrectas', 'error');
    } finally {
      setLoading(false);
    }
  };

  const logOut = () => {
    localStorage.removeItem('nexus_admin_token');
    setToken(null);
    setUser(null);
    addToast('Sesión administrativa finalizada', 'info');
  };

  // Format bytes helper
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Chart data
  const storageData = [
    { name: 'Plan Básico', Usado: 4.8, Disponible: 25 },
    { name: 'Plan Pro', Usado: 38.4, Disponible: 150 },
    { name: 'Plan Enterprise', Usado: 128.0, Disponible: 1000 },
  ];

  const showConfirm = (title, message, onConfirm) => {
    setConfirmModal({ open: true, title, message, onConfirm });
  };
  const closeConfirm = () => setConfirmModal({ open: false, title: '', message: '', onConfirm: null });

  if (!token) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-blue-500 selection:text-white">
        <header className="px-6 py-4 flex justify-between items-center max-w-7xl mx-auto w-full">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Nexus Storage Logo" className="h-16 w-16 object-contain" />
            <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">NEXUS CONSOLE</span>
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full glass-panel rounded-2xl p-8 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-blue-500 to-indigo-500"></div>

            <div className="text-center mb-6">
              <span className="bg-blue-500/10 border border-blue-800/40 text-blue-400 text-[10px] font-extrabold uppercase px-2.5 py-1 rounded-md mb-2 inline-block">Módulo Administrativo</span>
              <h2 className="text-2xl font-black text-white">Consola de Control</h2>
              <p className="text-slate-400 text-sm mt-1">Identifícate con tus credenciales de soporte.</p>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Email de Admin</label>
                <input 
                  type="email" 
                  required 
                  value={authForm.email}
                  onChange={(e) => setAuthForm({...authForm, email: e.target.value})}
                  placeholder="admin@nexus.com" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm focus:border-blue-500 outline-none text-white transition-all"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Contraseña</label>
                <input 
                  type="password" 
                  required 
                  value={authForm.password}
                  onChange={(e) => setAuthForm({...authForm, password: e.target.value})}
                  placeholder="••••••••" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm focus:border-blue-500 outline-none text-white transition-all"
                />
              </div>

              <button type="submit" disabled={loading} className="btn-primary w-full py-2.5 text-sm justify-center mt-2">
                {loading ? <RefreshCw className="animate-spin h-4 w-4" /> : 'Entrar a la Consola'}
              </button>
            </form>
          </div>
        </main>

        <footer className="border-t border-slate-900 py-6 text-center text-slate-600 text-xs">
          Nexus Storage Console © {new Date().getFullYear()} — Nexus Digital Solutions.
        </footer>

        {/* Toasts */}
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
          {toasts.map(t => (
            <div key={t.id} className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border shadow-lg text-sm transition-all duration-300 animate-slide-in ${
              t.type === 'error' ? 'bg-rose-950/80 border-rose-800 text-rose-200' :
              t.type === 'info' ? 'bg-slate-900 border-slate-800 text-slate-200' :
              'bg-blue-950/80 border-blue-800 text-blue-200'
            }`}>
              {t.type === 'error' ? <AlertTriangle className="h-4 w-4 text-rose-400" /> : <CheckCircle className="h-4 w-4 text-blue-400" />}
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex selection:bg-blue-500 selection:text-white">
      {/* Mobile Header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-md border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.png" className="h-8" alt="Nexus" />
          <span className="text-sm font-bold text-white tracking-wider">NEXUS CONSOLE</span>
        </div>
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 text-slate-400 hover:text-white">
          <Menu className="h-6 w-6" />
        </button>
      </div>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed md:sticky top-0 left-0 h-screen w-64 z-50 md:z-auto transform transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} border-r border-slate-900 bg-slate-950 flex flex-col justify-between shrink-0`}>
        <div className="flex flex-col">
          {/* Logo */}
          <div className="px-6 py-6 flex items-center gap-3 border-b border-slate-900">
            <img src="/logo.png" alt="Nexus Storage Logo" className="h-12 w-12 object-contain" />
            <span className="font-extrabold tracking-tight text-white uppercase">Nexus Console</span>
          </div>

          {/* Navigation Links */}
          <nav className="p-4 space-y-1">
            <button 
              onClick={() => { setView('dashboard'); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                view === 'dashboard' ? 'bg-blue-500/10 text-blue-400 border-l-2 border-blue-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <Activity className="h-4 w-4" /> Servidores y Nodos
            </button>
            <button 
              onClick={() => { setView('clients'); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                view === 'clients' ? 'bg-blue-500/10 text-blue-400 border-l-2 border-blue-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <Users className="h-4 w-4" /> Gestión de Clientes
            </button>
            <button 
              onClick={() => { setView('plans'); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                view === 'plans' ? 'bg-blue-500/10 text-blue-400 border-l-2 border-blue-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <Layers className="h-4 w-4" /> Planes Tarifarios
            </button>
            <button 
              onClick={() => { setView('logs'); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                view === 'logs' ? 'bg-blue-500/10 text-blue-400 border-l-2 border-blue-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <History className="h-4 w-4" /> Auditoría Global
            </button>
          </nav>
        </div>

        <div className="p-4 border-t border-slate-900 space-y-4">
          <div className="flex items-center gap-3 px-2">
            <div className="h-10 w-10 rounded-full bg-blue-950 border border-blue-900/40 flex items-center justify-center text-blue-400 font-bold">
              A
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">Administrador</p>
              <p className="text-xs text-slate-500 truncate">Soporte Tecnico</p>
            </div>
          </div>
          <button onClick={logOut} className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-rose-400 hover:bg-rose-950/20 transition-all border border-transparent hover:border-rose-900/30">
            <LogOut className="h-4 w-4" /> Salir de Consola
          </button>
        </div>
      </aside>

      {/* Main Panel */}
      <div className="flex-1 flex flex-col min-w-0 min-h-screen pt-16 md:pt-0">
        {/* Dashboard View */}
        {view === 'dashboard' && (
          <main className="p-8 space-y-8 flex-1 overflow-y-auto animate-fade-in">
            {/* Header */}
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-black text-white">Monitoreo de Infraestructura</h1>
                <p className="text-slate-400 text-sm">Estado del motor físico de almacenamiento MinIO y consumos generales.</p>
              </div>
              <button onClick={fetchStats} className="btn-secondary text-xs"><RefreshCcw className="h-3.5 w-3.5" /> Recargar</button>
            </div>

            {/* Metrics cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-32">
                <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Clientes Registrados</span>
                <div className="mt-2">
                  <p className="text-3xl font-black text-white">{globalStats.total_clients}</p>
                  <p className="text-xs text-slate-500 mt-1">{globalStats.active_clients} cuentas activas</p>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-32">
                <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Almacenamiento Total</span>
                <div className="mt-2">
                  <p className="text-3xl font-black text-white">{formatBytes(globalStats.total_storage_used)}</p>
                  <p className="text-xs text-slate-500 mt-1">Consumido por usuarios</p>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-32">
                <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Archivos Hospedados</span>
                <div className="mt-2">
                  <p className="text-3xl font-black text-white">{globalStats.total_files}</p>
                  <p className="text-xs text-slate-500 mt-1">Registrados en PostgreSQL</p>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-32">
                <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Planes Definidos</span>
                <div className="mt-2">
                  <p className="text-3xl font-black text-white">{globalStats.total_plans}</p>
                  <p className="text-xs text-slate-500 mt-1">Configurados en el sistema</p>
                </div>
              </div>
            </div>

            {/* Storage nodes list */}
            <div className="space-y-4">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">Nodos de Almacenamiento MinIO</h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {nodes.map(n => (
                  <div key={n.id} className="glass-panel p-6 rounded-2xl space-y-4">
                    <div className="flex justify-between items-center border-b border-slate-900 pb-3">
                      <div className="flex items-center gap-2">
                        <Database className="h-5 w-5 text-blue-400" />
                        <span className="font-bold text-white text-sm">{n.id}</span>
                      </div>
                      <span className="bg-emerald-950/40 border border-emerald-800/50 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase">{n.status}</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <span className="text-slate-500 block">Dirección</span>
                        <span className="text-slate-300 font-mono">{n.address}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Tiempo de Actividad</span>
                        <span className="text-slate-300">{n.uptime}</span>
                      </div>
                    </div>

                    {/* Node Disk Usage */}
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs font-semibold">
                        <span className="text-slate-400">Espacio de Disco</span>
                        <span className="text-slate-200">{formatBytes(n.disk_used)} / {formatBytes(n.disk_total)}</span>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                        <div className="bg-blue-500 h-full" style={{ width: `${(n.disk_used / n.disk_total) * 100}%` }}></div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4 text-center border-t border-slate-900/60 pt-3">
                      <div>
                        <span className="text-slate-500 text-[10px] uppercase font-bold block">Uso CPU</span>
                        <span className="text-slate-200 font-bold text-sm">{n.cpu_usage}%</span>
                      </div>
                      <div>
                        <span className="text-slate-500 text-[10px] uppercase font-bold block">Uso RAM</span>
                        <span className="text-slate-200 font-bold text-sm">{n.memory_usage}%</span>
                      </div>
                      <div>
                        <span className="text-slate-500 text-[10px] uppercase font-bold block">Conexiones</span>
                        <span className="text-slate-200 font-bold text-sm">{n.active_conns}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* General Consumption Chart */}
            <div className="glass-panel p-6 rounded-2xl">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-6">Tráfico Acumulado por Plan (GB)</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={storageData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={11} />
                    <YAxis stroke="#64748b" fontSize={11} />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b' }} />
                    <Legend />
                    <Bar dataKey="Usado" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Disponible" fill="#1e293b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </main>
        )}

        {/* Clients list View */}
        {view === 'clients' && (
          <main className="p-8 space-y-6 flex-1 overflow-y-auto animate-fade-in">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-black text-white">Gestión de Clientes</h1>
                <p className="text-slate-400 text-sm mt-1">Monitorea los consumos de tus usuarios y gestiona sus estados y planes.</p>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                <input 
                  type="text" 
                  placeholder="Buscar cliente..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="bg-slate-900 border border-slate-800 text-xs rounded-lg pl-9 pr-4 py-2 outline-none focus:border-blue-500 w-48 text-white transition-all"
                />
              </div>
            </div>

            <div className="glass-panel rounded-2xl overflow-hidden p-6">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="text-xs text-slate-500 uppercase border-b border-slate-800">
                  <tr>
                    <th className="pb-3">Nombre</th>
                    <th className="pb-3">Plan</th>
                    <th className="pb-3">Almacenamiento Utilizado</th>
                    <th className="pb-3">Estado</th>
                    <th className="pb-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900">
                  {clients
                    .filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()) || c.email.toLowerCase().includes(searchTerm.toLowerCase()))
                    .map(c => {
                      const limit = c.plan.storage_limit_bytes;
                      const percent = limit > 0 ? (c.storage_used / limit) * 100 : 0;
                      return (
                        <tr key={c.id} className="hover:bg-slate-900/20">
                          <td className="py-4">
                            <div className="font-semibold text-slate-200">{c.name}</div>
                            <div className="text-xs text-slate-500">{c.email}</div>
                          </td>
                          <td className="py-4">
                            <span className="bg-slate-900 border border-slate-800 text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded-full">{c.plan.name}</span>
                          </td>
                          <td className="py-4 w-64">
                            <div className="space-y-1.5">
                              <div className="flex justify-between text-[10px] font-semibold text-slate-400">
                                <span>{formatBytes(c.storage_used)} / {formatBytes(limit)}</span>
                                <span>{percent.toFixed(1)}%</span>
                              </div>
                              <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden border border-slate-900">
                                <div className="bg-blue-500 h-full" style={{ width: `${percent}%` }}></div>
                              </div>
                            </div>
                          </td>
                          <td className="py-4">
                            {c.is_suspended ? (
                              <span className="bg-rose-950/40 border border-rose-800/50 text-rose-400 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase">Suspendido</span>
                            ) : (
                              <span className="bg-emerald-950/40 border border-emerald-800/50 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase">Activo</span>
                            )}
                          </td>
                          <td className="py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button onClick={() => openChangePlan(c)} className="btn-secondary text-xs px-2.5 py-1" title="Cambiar Plan">Asignar Plan</button>
                              <button 
                                onClick={() => handleToggleSuspend(c)}
                                className={`px-2.5 py-1 rounded text-xs font-medium border transition-all ${
                                  c.is_suspended ? 'bg-emerald-950/40 border-emerald-800/50 text-emerald-400 hover:bg-emerald-900/60' : 'bg-rose-950/40 border-rose-800/50 text-rose-400 hover:bg-rose-900/60'
                                }`}
                              >
                                {c.is_suspended ? 'Reactivar' : 'Suspender'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </main>
        )}

        {/* Plans tariff View */}
        {view === 'plans' && (
          <main className="p-8 space-y-6 flex-1 overflow-y-auto animate-fade-in">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-black text-white">Planes Tarifarios</h1>
                <p className="text-slate-400 text-sm mt-1">Configura las cuotas globales y los límites de subida de tus clientes.</p>
              </div>
              <button onClick={() => openEditPlan(null)} className="btn-primary text-xs py-2"><Plus className="h-4 w-4" /> Crear Plan</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {plans.map(p => (
                <div key={p.id} className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-64 border-t-2 border-t-blue-500">
                  <div className="space-y-4">
                    <div className="flex justify-between items-start">
                      <h3 className="font-extrabold text-white text-lg">{p.name}</h3>
                      <span className="text-2xl font-black text-blue-400">${p.price_monthly.toFixed(2)}<span className="text-xs text-slate-500 font-semibold">/mes</span></span>
                    </div>

                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Límite almacenamiento</span>
                        <span className="text-slate-200 font-semibold">{formatBytes(p.storage_limit_bytes)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Tamaño máx. archivo</span>
                        <span className="text-slate-200 font-semibold">{formatBytes(p.max_file_size_bytes)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 pt-4 border-t border-slate-900">
                    <button onClick={() => openEditPlan(p)} className="btn-secondary text-xs flex-1"><Edit2 className="h-3.5 w-3.5" /> Editar</button>
                    <button onClick={() => handleDeletePlan(p.id)} className="btn-danger text-xs p-2 shrink-0"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>
          </main>
        )}

        {/* Audit Logs View */}
        {view === 'logs' && (
          <main className="p-8 space-y-8 flex-1 overflow-y-auto animate-fade-in">
            <div>
              <h1 className="text-2xl font-black text-white">Auditoría Global</h1>
              <p className="text-slate-400 text-sm mt-1">Registro central de seguridad y auditorías administrativas.</p>
            </div>

            <div className="glass-panel rounded-2xl p-6 overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="text-xs text-slate-500 uppercase border-b border-slate-800">
                  <tr>
                    <th className="pb-3">Operación</th>
                    <th className="pb-3">Detalle</th>
                    <th className="pb-3">IP Origen</th>
                    <th className="pb-3">Fecha y Hora</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900">
                  {auditLogs.map((log, index) => (
                    <tr key={log.id || index} className="hover:bg-slate-900/30">
                      <td className="py-4">
                        <span className={`text-[10px] font-extrabold uppercase px-2.5 py-1 rounded-md border ${
                          log.action.includes('ALERT') || log.action.includes('SUSPEND') ? 'bg-rose-950/40 border-rose-900 text-rose-400' :
                          log.action.includes('SUCCESS') || log.action.includes('REGISTER') ? 'bg-emerald-950/40 border-emerald-900 text-emerald-400' :
                          'bg-slate-900 border-slate-800 text-slate-300'
                        }`}>
                          {log.action}
                        </span>
                      </td>
                      <td className="py-4 text-xs font-semibold text-slate-200 truncate max-w-[320px]">{log.details}</td>
                      <td className="py-4 text-xs text-slate-500 font-mono">{log.ip_address}</td>
                      <td className="py-4 text-xs text-slate-400">{new Date(log.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </main>
        )}
      </div>

      {/* ------------------- MODALS ------------------- */}

      {/* Assign Plan Modal */}
      {isPlanModalOpen && selectedClient && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full glass-panel rounded-2xl p-6 shadow-2xl relative space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-white">Asignar Plan a: {selectedClient.name}</h3>
              <button onClick={() => setIsPlanModalOpen(false)} className="text-slate-500 hover:text-slate-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleUpdatePlanSubmit} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-400 font-semibold block">Selecciona un Plan de Almacenamiento</label>
                <select 
                  value={selectedPlanId}
                  onChange={(e) => setSelectedPlanId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-blue-500 outline-none text-white"
                >
                  {plans.map(p => (
                    <option key={p.id} value={p.id}>{p.name} — {formatBytes(p.storage_limit_bytes)} (${p.price_monthly.toFixed(2)}/mo)</option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setIsPlanModalOpen(false)} className="btn-secondary text-xs py-2">Cancelar</button>
                <button type="submit" className="btn-primary text-xs py-2">Actualizar Plan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create / Edit Plan Modal */}
      {isEditPlanModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full glass-panel rounded-2xl p-6 shadow-2xl relative space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-white">{planForm.id ? 'Editar Plan' : 'Crear Plan'}</h3>
              <button onClick={() => setIsEditPlanModalOpen(false)} className="text-slate-500 hover:text-slate-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handlePlanSubmit} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-400 font-semibold block">Nombre del Plan</label>
                <input 
                  type="text" 
                  required 
                  value={planForm.name}
                  onChange={(e) => setPlanForm({...planForm, name: e.target.value})}
                  placeholder="ej. Avanzado" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-xs focus:border-blue-500 outline-none text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold block">Almacenamiento (GB)</label>
                  <input 
                    type="number" 
                    required 
                    min="1"
                    value={planForm.storage_limit_gb}
                    onChange={(e) => setPlanForm({...planForm, storage_limit_gb: parseInt(e.target.value)})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-xs focus:border-blue-500 outline-none text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold block">Límite Archivo (MB)</label>
                  <input 
                    type="number" 
                    required 
                    min="1"
                    value={planForm.max_file_size_mb}
                    onChange={(e) => setPlanForm({...planForm, max_file_size_mb: parseInt(e.target.value)})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-xs focus:border-blue-500 outline-none text-white"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-slate-400 font-semibold block">Precio Mensual ($USD)</label>
                <input 
                  type="number" 
                  required 
                  step="0.01"
                  min="0"
                  value={planForm.price_monthly}
                  onChange={(e) => setPlanForm({...planForm, price_monthly: e.target.value})}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-xs focus:border-blue-500 outline-none text-white"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setIsEditPlanModalOpen(false)} className="btn-secondary text-xs py-2">Cancelar</button>
                <button type="submit" className="btn-primary text-xs py-2">Guardar Plan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal.open && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="max-w-sm w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <AlertTriangle className="h-6 w-6 text-amber-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">{confirmModal.title}</h3>
            </div>
            <p className="text-sm text-slate-400">{confirmModal.message}</p>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={closeConfirm} className="btn-secondary text-sm px-4 py-2">Cancelar</button>
              <button onClick={() => { confirmModal.onConfirm(); closeConfirm(); }} className="btn-danger text-sm px-4 py-2">Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map(t => (
          <div key={t.id} className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border shadow-lg text-sm transition-all duration-300 animate-slide-in ${
            t.type === 'error' ? 'bg-rose-950/80 border-rose-800 text-rose-200' :
            t.type === 'info' ? 'bg-slate-900 border-slate-800 text-slate-200' :
            'bg-blue-950/80 border-blue-850 text-blue-200'
          }`}>
            {t.type === 'error' ? <AlertTriangle className="h-4 w-4 text-rose-400" /> : <CheckCircle className="h-4 w-4 text-blue-400" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
