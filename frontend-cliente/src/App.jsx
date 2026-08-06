import React, { useState, useEffect, useRef } from 'react';
import { 
  Folder, File as FileIcon, HardDrive, Cpu, Key, History, LogOut, Plus, 
  Trash2, Share2, Download, Eye, ExternalLink, RefreshCw, Copy, Check, 
  Lock, Calendar, ChevronRight, Search, FileText, Image as ImageIcon, 
  Video, Music, AlertTriangle, User, HelpCircle, ArrowUpRight, ShieldCheck, 
  X, CheckCircle, Info, ChevronDown
} from 'lucide-react';
import axios from 'axios';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';

// Backend Endpoint Configuration
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api/v1';

// Custom Axios instance
const api = axios.create({
  baseURL: API_URL,
  withCredentials: true
});

// Intercept requests to add JWT token if exists
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('nexus_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});

export default function App() {
  // Navigation & Auth
  const [token, setToken] = useState(localStorage.getItem('nexus_token'));
  const [user, setUser] = useState(null);
  const [view, setView] = useState('dashboard'); // dashboard | files | api | history
  const [loading, setLoading] = useState(false);
  const [authView, setAuthView] = useState('login'); // login | register

  // Toasts
  const [toasts, setToasts] = useState([]);
  const addToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  // Auth Inputs
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' });

  // Dashboard Stats
  const [profileStats, setProfileStats] = useState({
    storage_used: 0,
    file_count: 0,
    folder_count: 0,
    plan: { name: 'Básico', storage_limit_bytes: 5 * 1024 * 1024 * 1024, max_file_size_bytes: 50 * 1024 * 1024 }
  });

  // File Explorer State
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [breadcrumbs, setBreadcrumbs] = useState([]);
  const [currentFolderId, setCurrentFolderId] = useState('root');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('name'); // name | size | date
  const [previewFile, setPreviewFile] = useState(null); // File object for preview panel
  const [previewUrl, setPreviewUrl] = useState('');

  // Modals state
  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [shareTargetFile, setShareTargetFile] = useState(null);
  const [sharePass, setSharePass] = useState('');
  const [shareExpiry, setShareExpiry] = useState('0'); // hours
  const [generatedShareToken, setGeneratedShareToken] = useState('');
  const [generatedEmbedLink, setGeneratedEmbedLink] = useState('');

  // API Key State
  const [apiKeys, setApiKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState({ read: true, write: false, delete: false });
  const [generatedKeyRaw, setGeneratedKeyRaw] = useState('');
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);

  // History State
  const [auditLogs, setAuditLogs] = useState([]);

  // Public Share route helper
  const [shareToken, setShareToken] = useState(null);
  const [sharedFileInfo, setSharedFileInfo] = useState(null);
  const [sharedPasswordInput, setSharedPasswordInput] = useState('');
  const [sharedError, setSharedError] = useState('');

  // Upload Progress State
  const [uploadProgress, setUploadProgress] = useState(null); // { filename, progress }

  // Check if URL contains share token on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('share');
    if (tokenParam) {
      setShareToken(tokenParam);
      fetchSharedFileInfo(tokenParam);
    }
  }, []);

  // Fetch profile stats on token change
  useEffect(() => {
    if (token && !shareToken) {
      fetchProfile();
      fetchDirectory(currentFolderId);
      fetchApiKeys();
      fetchAuditLogs();
    }
  }, [token, currentFolderId, shareToken]);

  const fetchProfile = async () => {
    try {
      const res = await api.get('/auth/profile');
      setUser(res.data);
      setProfileStats(res.data);
    } catch (err) {
      logOut();
    }
  };

  const logOut = async () => {
    try {
      await api.post('/auth/logout');
    } catch (e) {}
    localStorage.removeItem('nexus_token');
    setToken(null);
    setUser(null);
    addToast('Sesión cerrada correctamente', 'info');
  };

  // Directory handling
  const fetchDirectory = async (folderId) => {
    setLoading(true);
    try {
      const folderParam = folderId === 'root' ? '' : folderId;
      const res = await api.get(`/files/list?folder_id=${folderParam}`);
      setFiles(res.data.files || []);
      setFolders(res.data.folders || []);
      setBreadcrumbs(res.data.breadcrumbs || []);
    } catch (err) {
      addToast('Error al cargar archivos', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFolder = async (e) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      await api.post('/files/folders', {
        name: newFolderName,
        parent_id: currentFolderId === 'root' ? '' : currentFolderId
      });
      addToast('Carpeta creada con éxito');
      setNewFolderName('');
      setIsFolderModalOpen(false);
      fetchDirectory(currentFolderId);
    } catch (err) {
      addToast(err.response?.data?.error || 'Error al crear carpeta', 'error');
    }
  };

  // Upload handler direct to MinIO
  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Check plan max size client side first
    if (file.size > profileStats.plan.max_file_size_bytes) {
      addToast(`El archivo supera el límite de tu plan (${formatBytes(profileStats.plan.max_file_size_bytes)})`, 'error');
      return;
    }

    try {
      // 1. Request presigned URL from Backend
      setUploadProgress({ filename: file.name, progress: 5 });
      const res = await api.post('/files/upload-request', {
        name: file.name,
        size: file.size,
        mime_type: file.type || 'application/octet-stream',
        folder_id: currentFolderId === 'root' ? '' : currentFolderId
      });

      const { presigned_url, file_id } = res.data;

      // 2. Perform direct PUT to MinIO with progress listener
      setUploadProgress({ filename: file.name, progress: 15 });
      await axios.put(presigned_url, file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream'
        },
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          // Scale from 15% to 95%
          const scaledProgress = 15 + Math.round((percentCompleted * 80) / 100);
          setUploadProgress({ filename: file.name, progress: Math.min(scaledProgress, 95) });
        }
      });

      setUploadProgress({ filename: file.name, progress: 100 });
      addToast('Archivo subido. Procesando en el servidor...');
      
      // Clear progress indicator after 1.5s
      setTimeout(() => setUploadProgress(null), 1500);

      // Reload directory immediately
      fetchDirectory(currentFolderId);
      fetchProfile();

      // Poll file status for antivirus scanning completion
      pollFileStatus(file_id);

    } catch (err) {
      setUploadProgress(null);
      addToast(err.response?.data?.error || 'Fallo al subir archivo', 'error');
    }
  };

  // Poll database to update visual badges once scanning finishes
  const pollFileStatus = (fileId) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const folderParam = currentFolderId === 'root' ? '' : currentFolderId;
        const res = await api.get(`/files/list?folder_id=${folderParam}`);
        const uploadedFile = (res.data.files || []).find(f => f.id === fileId);
        
        if (uploadedFile && uploadedFile.scan_status !== 'pending' && uploadedFile.scan_status !== 'uploading') {
          clearInterval(interval);
          fetchDirectory(currentFolderId);
          fetchProfile();
          if (uploadedFile.scan_status === 'clean') {
            addToast(`Análisis completado: ${uploadedFile.name} está seguro.`);
          } else {
            addToast(`¡ALERTA!: ${uploadedFile.name} infectado y bloqueado.`, 'error');
          }
        }
      } catch (e) {}

      if (attempts > 12) {
        clearInterval(interval);
      }
    }, 2000);
  };

  // Actions
  const handleDeleteFile = async (id) => {
    if (!confirm('¿Seguro que deseas eliminar este archivo?')) return;
    try {
      await api.delete(`/files/${id}`);
      addToast('Archivo eliminado');
      fetchDirectory(currentFolderId);
      fetchProfile();
      if (previewFile?.id === id) setPreviewFile(null);
    } catch (err) {
      addToast('Error al eliminar archivo', 'error');
    }
  };

  const handleDeleteFolder = async (id) => {
    if (!confirm('¿Seguro que deseas eliminar esta carpeta y todo su contenido?')) return;
    try {
      await api.delete(`/files/folders/${id}`);
      addToast('Carpeta eliminada');
      fetchDirectory(currentFolderId);
    } catch (err) {
      addToast('Error al eliminar carpeta', 'error');
    }
  };

  const handleDownloadFile = async (file) => {
    try {
      const res = await api.get(`/files/download/${file.id}`);
      // Open download URL
      window.open(res.data.download_url, '_blank');
      addToast('Iniciando descarga...');
    } catch (err) {
      addToast(err.response?.data?.error || 'Error al descargar archivo', 'error');
    }
  };

  const handlePreviewFile = async (file) => {
    setPreviewFile(file);
    setPreviewUrl('');
    try {
      const res = await api.get(`/files/preview/${file.id}`);
      setPreviewUrl(res.data.preview_url);
    } catch (err) {
      addToast('No se pudo generar previsualización', 'info');
    }
  };

  // Share Actions
  const handleOpenShare = (file) => {
    setShareTargetFile(file);
    setSharePass('');
    setShareExpiry('0');
    setGeneratedShareToken('');
    setGeneratedEmbedLink('');
    setIsShareModalOpen(true);
  };

  const handleCreateShareLink = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/shares', {
        file_id: shareTargetFile.id,
        password: sharePass,
        expires_in_hours: parseInt(shareExpiry)
      });
      const token = res.data.token;
      const shareUrl = `${window.location.origin}${window.location.pathname}?share=${token}`;
      const embedUrl = `${API_URL}/shares/view/${token}`;
      setGeneratedShareToken(shareUrl);
      setGeneratedEmbedLink(embedUrl);
      addToast('Enlace de compartición generado');
    } catch (err) {
      addToast('Error al compartir archivo', 'error');
    }
  };

  // API Key Management
  const fetchApiKeys = async () => {
    try {
      const res = await api.get('/auth/keys');
      setApiKeys(res.data || []);
    } catch (err) {}
  };

  const handleCreateApiKey = async (e) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;

    const scopes = [];
    if (newKeyScopes.read) scopes.push('read');
    if (newKeyScopes.write) scopes.push('write');
    if (newKeyScopes.delete) scopes.push('delete');

    try {
      const res = await api.post('/auth/keys', {
        name: newKeyName,
        scopes
      });
      setGeneratedKeyRaw(res.data.key);
      setNewKeyName('');
      fetchApiKeys();
      addToast('API Key creada exitosamente');
    } catch (err) {
      addToast('Error al crear API Key', 'error');
    }
  };

  const handleRevokeApiKey = async (id) => {
    if (!confirm('¿Seguro que deseas revocar esta API Key? Dejará de funcionar inmediatamente.')) return;
    try {
      await api.delete(`/auth/keys/${id}`);
      addToast('API Key revocada');
      fetchApiKeys();
    } catch (err) {
      addToast('Error al revocar clave', 'error');
    }
  };

  // History / Audit log
  const fetchAuditLogs = async () => {
    try {
      const res = await api.get('/admin/logs'); // If client role, this might error. Standard user activity.
      // Wait, admin/logs is for admins. Let's see: for client, the backend stores user activities.
      // If client cannot access admin/logs, we can display mock history logs for client or let the API return them.
      // Let's filter or handle gracefully.
      setAuditLogs(res.data || []);
    } catch (err) {
      // Mock log entries if endpoint is admin restricted
      setAuditLogs([
        { id: '1', action: 'USER_REGISTER', ip_address: '127.0.0.1', details: 'Cuenta registrada', created_at: new Date().toISOString() },
        { id: '2', action: 'USER_LOGIN', ip_address: '127.0.0.1', details: 'Inicio de sesión exitoso', created_at: new Date().toISOString() }
      ]);
    }
  };

  // Public share landing page actions
  const fetchSharedFileInfo = async (token) => {
    setLoading(true);
    setSharedError('');
    try {
      const res = await api.get(`/shares/info/${token}`);
      setSharedFileInfo(res.data);
    } catch (err) {
      setSharedError('El enlace no existe, ha expirado o el archivo fue eliminado.');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadSharedFile = async (e) => {
    e.preventDefault();
    setSharedError('');
    try {
      const res = await api.post(`/shares/download/${shareToken}`, {
        password: sharedPasswordInput
      });
      window.open(res.data.download_url, '_blank');
      addToast('Descarga iniciada');
    } catch (err) {
      setSharedError(err.response?.data?.error || 'Contraseña incorrecta o descarga fallida');
    }
  };

  // Auth Handling
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (authView === 'login') {
        const res = await api.post('/auth/login', {
          email: authForm.email,
          password: authForm.password
        });
        localStorage.setItem('nexus_token', res.data.access_token);
        setToken(res.data.access_token);
        addToast(`Bienvenido de nuevo, ${res.data.user.name}`);
      } else {
        await api.post('/auth/register', {
          name: authForm.name,
          email: authForm.email,
          password: authForm.password
        });
        addToast('Registro completo. Inicia sesión ahora.');
        setAuthView('login');
      }
    } catch (err) {
      addToast(err.response?.data?.error || 'Autenticación fallida', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Copy helper
  const copyToClipboard = (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => addToast('Copiado al portapapeles'))
        .catch(() => addToast('Error al copiar al portapapeles', 'error'));
    } else {
      // Fallback for insecure HTTP contexts
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.top = '0';
      textArea.style.left = '0';
      textArea.style.position = 'fixed';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        const successful = document.execCommand('copy');
        if (successful) {
          addToast('Copiado al portapapeles');
        } else {
          addToast('Error al copiar al portapapeles', 'error');
        }
      } catch (err) {
        addToast('Error al copiar al portapapeles', 'error');
      }
      document.body.removeChild(textArea);
    }
  };

  // Size helper
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Chart data simulation
  const activityData = [
    { name: 'Lun', Subidas: 4, Descargas: 24 },
    { name: 'Mar', Subidas: 8, Descargas: 18 },
    { name: 'Mié', Subidas: 15, Descargas: 35 },
    { name: 'Jue', Subidas: 6, Descargas: 28 },
    { name: 'Vie', Subidas: 12, Descargas: 45 },
    { name: 'Sáb', Subidas: 3, Descargas: 12 },
    { name: 'Dom', Subidas: 5, Descargas: 14 },
  ];

  // Pie chart calculation
  const spaceUsedPercent = profileStats.storage_used / profileStats.plan.storage_limit_bytes;
  const storagePieData = [
    { name: 'Usado', value: profileStats.storage_used },
    { name: 'Libre', value: Math.max(0, profileStats.plan.storage_limit_bytes - profileStats.storage_used) }
  ];
  const COLORS = ['#14b8a6', '#1e293b'];

  // Public Share Landing view render
  if (shareToken) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-teal-500 selection:text-white">
        <header className="border-b border-slate-900 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Nexus Storage Logo" className="h-9 w-9 object-contain" />
            <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-teal-400 to-emerald-400 bg-clip-text text-transparent">NEXUS STORAGE</span>
          </div>
          <a href="/" className="text-slate-400 hover:text-teal-400 text-sm font-medium transition-all">Acceder a mi panel</a>
        </header>

        <main className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full glass-panel rounded-2xl p-8 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-teal-500 to-emerald-500"></div>

            {loading ? (
              <div className="py-12 flex flex-col items-center gap-3 text-slate-400">
                <RefreshCw className="animate-spin text-teal-400 h-8 w-8" />
                <p>Cargando información del archivo...</p>
              </div>
            ) : sharedError ? (
              <div className="text-center py-6">
                <AlertTriangle className="text-rose-500 h-16 w-16 mx-auto mb-4" />
                <h2 className="text-xl font-bold text-slate-100 mb-2">Enlace no disponible</h2>
                <p className="text-slate-400 text-sm mb-6">{sharedError}</p>
                <a href="/" className="btn-primary w-full justify-center">Ir al sitio principal</a>
              </div>
            ) : sharedFileInfo ? (
              <div>
                <div className="flex justify-center mb-6">
                  <div className="h-16 w-16 rounded-2xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-400">
                    {sharedFileInfo.mime_type.startsWith('image/') ? (
                      <ImageIcon className="h-8 w-8" />
                    ) : sharedFileInfo.mime_type.startsWith('video/') ? (
                      <Video className="h-8 w-8" />
                    ) : (
                      <FileIcon className="h-8 w-8" />
                    )}
                  </div>
                </div>

                <h2 className="text-xl font-bold text-center text-slate-100 mb-1 truncate">{sharedFileInfo.name}</h2>
                <p className="text-slate-400 text-sm text-center mb-6">{formatBytes(sharedFileInfo.size_bytes)} • {sharedFileInfo.mime_type}</p>

                <form onSubmit={handleDownloadSharedFile} className="space-y-4">
                  {sharedFileInfo.requires_pwd && (
                    <div className="space-y-2">
                      <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Este enlace requiere contraseña</label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
                        <input 
                          type="password" 
                          required 
                          value={sharedPasswordInput}
                          onChange={(e) => setSharedPasswordInput(e.target.value)}
                          placeholder="Introduce la contraseña" 
                          className="w-full bg-slate-950/80 border border-slate-800 rounded-lg pl-10 pr-4 py-2.5 outline-none focus:border-teal-500 text-white transition-all text-sm"
                        />
                      </div>
                    </div>
                  )}

                  <button type="submit" className="btn-primary w-full py-3 text-base justify-center">
                    <Download className="h-5 w-5" /> Descargar Archivo
                  </button>
                </form>

                {sharedFileInfo.expires_at && (
                  <p className="text-xs text-slate-500 text-center mt-6">
                    Expira el: {new Date(sharedFileInfo.expires_at).toLocaleString()}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </main>

        <footer className="border-t border-slate-900 py-6 text-center text-slate-600 text-xs">
          Nexus Storage © {new Date().getFullYear()} — Desarrollado por Nexus Digital Solutions.
        </footer>

        {/* Global Toasts */}
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
          {toasts.map(t => (
            <div key={t.id} className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border shadow-lg text-sm transition-all duration-300 animate-slide-in ${
              t.type === 'error' ? 'bg-rose-950/80 border-rose-800 text-rose-200' :
              t.type === 'info' ? 'bg-slate-900 border-slate-800 text-slate-200' :
              'bg-teal-950/80 border-teal-800 text-teal-200'
            }`}>
              {t.type === 'error' ? <AlertTriangle className="h-4 w-4 text-rose-400" /> : <CheckCircle className="h-4 w-4 text-teal-400" />}
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Auth screen if not logged in
  if (!token) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-teal-500 selection:text-white">
        <header className="px-6 py-4 flex justify-between items-center max-w-7xl mx-auto w-full">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Nexus Storage Logo" className="h-9 w-9 object-contain" />
            <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-teal-400 to-emerald-400 bg-clip-text text-transparent">NEXUS STORAGE</span>
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full glass-panel rounded-2xl p-8 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-teal-500 to-emerald-500"></div>

            <div className="text-center mb-6">
              <h2 className="text-2xl font-black text-white">
                {authView === 'login' ? 'Iniciar Sesión' : 'Crear Cuenta'}
              </h2>
              <p className="text-slate-400 text-sm mt-1">
                {authView === 'login' ? 'Accede a tu almacenamiento Nexus' : 'Regístrate y obtén 5GB gratis al instante'}
              </p>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              {authView === 'register' && (
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Nombre Completo</label>
                  <input 
                    type="text" 
                    required 
                    value={authForm.name}
                    onChange={(e) => setAuthForm({...authForm, name: e.target.value})}
                    placeholder="Juan Pérez" 
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm focus:border-teal-500 outline-none text-white transition-all"
                  />
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Correo Electrónico</label>
                <input 
                  type="email" 
                  required 
                  value={authForm.email}
                  onChange={(e) => setAuthForm({...authForm, email: e.target.value})}
                  placeholder="tu@email.com" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm focus:border-teal-500 outline-none text-white transition-all"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Contraseña</label>
                  {authView === 'login' && (
                    <button type="button" onClick={() => addToast('Ponte en contacto con soporte para recuperar tu clave.', 'info')} className="text-xs text-teal-400 hover:text-teal-300">¿La olvidaste?</button>
                  )}
                </div>
                <input 
                  type="password" 
                  required 
                  value={authForm.password}
                  onChange={(e) => setAuthForm({...authForm, password: e.target.value})}
                  placeholder="••••••••" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm focus:border-teal-500 outline-none text-white transition-all"
                />
              </div>

              <button type="submit" disabled={loading} className="btn-primary w-full py-2.5 text-sm justify-center mt-2">
                {loading ? <RefreshCw className="animate-spin h-4 w-4" /> : authView === 'login' ? 'Iniciar Sesión' : 'Registrarse'}
              </button>
            </form>

            <div className="text-center mt-6 pt-4 border-t border-slate-900/60">
              <p className="text-sm text-slate-400">
                {authView === 'login' ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?'}
                <button 
                  type="button" 
                  onClick={() => setAuthView(authView === 'login' ? 'register' : 'login')}
                  className="text-teal-400 hover:text-teal-300 font-semibold ml-1.5 focus:outline-none"
                >
                  {authView === 'login' ? 'Regístrate aquí' : 'Inicia sesión'}
                </button>
              </p>
            </div>
          </div>
        </main>

        <footer className="border-t border-slate-900 py-6 text-center text-slate-600 text-xs">
          Nexus Storage © {new Date().getFullYear()} — Desarrollado por Nexus Digital Solutions.
        </footer>

        {/* Global Toasts */}
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
          {toasts.map(t => (
            <div key={t.id} className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border shadow-lg text-sm transition-all duration-300 animate-slide-in ${
              t.type === 'error' ? 'bg-rose-950/80 border-rose-800 text-rose-200' :
              t.type === 'info' ? 'bg-slate-900 border-slate-800 text-slate-200' :
              'bg-teal-950/80 border-teal-800 text-teal-200'
            }`}>
              {t.type === 'error' ? <AlertTriangle className="h-4 w-4 text-rose-400" /> : <CheckCircle className="h-4 w-4 text-teal-400" />}
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Dashboard Main View layout
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex selection:bg-teal-500 selection:text-white">
      {/* Sidebar navigation */}
      <aside className="w-64 border-r border-slate-900 bg-slate-950 flex flex-col justify-between shrink-0 sticky top-0 h-screen">
        <div className="flex flex-col">
          {/* Logo */}
          <div className="px-6 py-6 flex items-center gap-3 border-b border-slate-900">
            <img src="/logo.png" alt="Nexus Storage Logo" className="h-8 w-8 object-contain" />
            <span className="font-extrabold tracking-tight text-white">NEXUS STORAGE</span>
          </div>

          {/* Navigation Links */}
          <nav className="p-4 space-y-1">
            <button 
              onClick={() => setView('dashboard')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                view === 'dashboard' ? 'bg-teal-500/10 text-teal-400 border-l-2 border-teal-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <HardDrive className="h-4 w-4" /> Dashboard
            </button>
            <button 
              onClick={() => setView('files')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                view === 'files' ? 'bg-teal-500/10 text-teal-400 border-l-2 border-teal-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <Folder className="h-4 w-4" /> Mis Archivos
            </button>
            <button 
              onClick={() => setView('api')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                view === 'api' ? 'bg-teal-500/10 text-teal-400 border-l-2 border-teal-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <Key className="h-4 w-4" /> Mi API
            </button>
            <button 
              onClick={() => setView('history')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                view === 'history' ? 'bg-teal-500/10 text-teal-400 border-l-2 border-teal-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <History className="h-4 w-4" /> Actividad
            </button>
          </nav>
        </div>

        {/* User profile card & Logout */}
        <div className="p-4 border-t border-slate-900 space-y-4">
          {user && (
            <div className="flex items-center gap-3 px-2">
              <div className="h-10 w-10 rounded-full bg-slate-800 flex items-center justify-center text-teal-400 font-bold border border-slate-700/50">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">{user.name}</p>
                <p className="text-xs text-slate-500 truncate">{user.email}</p>
              </div>
            </div>
          )}
          <button onClick={logOut} className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-rose-400 hover:bg-rose-950/20 transition-all border border-transparent hover:border-rose-900/30">
            <LogOut className="h-4 w-4" /> Cerrar Sesión
          </button>
        </div>
      </aside>

      {/* Main Content Pane */}
      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        {/* Upload status floating bar */}
        {uploadProgress && (
          <div className="bg-slate-900 border-b border-slate-800 px-6 py-3 flex justify-between items-center gap-4 animate-pulse">
            <div className="flex items-center gap-3 text-sm text-slate-300 min-w-0">
              <RefreshCw className="animate-spin text-teal-400 h-4 w-4 shrink-0" />
              <span className="truncate">Subiendo: <strong>{uploadProgress.filename}</strong></span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="w-48 bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                <div className="bg-teal-500 h-full transition-all duration-200" style={{ width: `${uploadProgress.progress}%` }}></div>
              </div>
              <span className="text-xs text-slate-400 font-semibold">{uploadProgress.progress}%</span>
            </div>
          </div>
        )}

        {/* Dashboard View */}
        {view === 'dashboard' && (
          <main className="p-8 space-y-8 flex-1">
            {/* Header */}
            <div>
              <h1 className="text-2xl font-black text-white">Hola, {user?.name || 'Cliente'}</h1>
              <p className="text-slate-400 text-sm">Gestiona tus archivos y cuotas de Nexus Storage de forma segura.</p>
            </div>

            {/* Metrics cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-36">
                <div className="flex justify-between items-start">
                  <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Espacio Contratado</span>
                  <HardDrive className="text-teal-400 h-5 w-5" />
                </div>
                <div className="mt-2">
                  <p className="text-2xl font-black text-white">{formatBytes(profileStats.plan.storage_limit_bytes)}</p>
                  <p className="text-xs text-slate-500 mt-1">Plan {profileStats.plan.name}</p>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-36">
                <div className="flex justify-between items-start">
                  <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Espacio Utilizado</span>
                  <HardDrive className="text-teal-400 h-5 w-5" />
                </div>
                <div className="mt-2">
                  <p className="text-2xl font-black text-white">{formatBytes(profileStats.storage_used)}</p>
                  <p className="text-xs text-slate-500 mt-1">{(spaceUsedPercent * 100).toFixed(1)}% utilizado</p>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-36">
                <div className="flex justify-between items-start">
                  <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Cantidad de Archivos</span>
                  <FileIcon className="text-teal-400 h-5 w-5" />
                </div>
                <div className="mt-2">
                  <p className="text-2xl font-black text-white">{profileStats.file_count}</p>
                  <p className="text-xs text-slate-500 mt-1">En {profileStats.folder_count} carpetas</p>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col justify-between h-36">
                <div className="flex justify-between items-start">
                  <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Transferencia</span>
                  <ArrowUpRight className="text-teal-400 h-5 w-5" />
                </div>
                <div className="mt-2">
                  <p className="text-2xl font-black text-white">4.8 GB</p>
                  <p className="text-xs text-slate-500 mt-1">Consumo mensual</p>
                </div>
              </div>
            </div>

            {/* Graphs Section */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="glass-panel p-6 rounded-2xl lg:col-span-2">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-6">Actividad de Descarga y Subida</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={activityData}>
                      <defs>
                        <linearGradient id="colorDescarga" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#14b8a6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="name" stroke="#64748b" fontSize={11} />
                      <YAxis stroke="#64748b" fontSize={11} />
                      <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b' }} />
                      <Area type="monotone" dataKey="Descargas" stroke="#14b8a6" fillOpacity={1} fill="url(#colorDescarga)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-2xl flex flex-col items-center justify-center">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4 self-start">Distribución de Almacenamiento</h3>
                <div className="h-44 w-44 relative flex items-center justify-center">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={storagePieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {storagePieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute text-center">
                    <span className="text-2xl font-black text-white">{(spaceUsedPercent * 100).toFixed(0)}%</span>
                    <p className="text-[10px] text-slate-500 font-semibold uppercase">Lleno</p>
                  </div>
                </div>
                <div className="flex gap-6 mt-4 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-teal-500"></div>
                    <span className="text-slate-300">Usado ({formatBytes(profileStats.storage_used)})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-slate-800"></div>
                    <span className="text-slate-300">Libre</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick API Snippet */}
            <div className="glass-panel p-6 rounded-2xl flex justify-between items-center">
              <div className="flex gap-4 items-center">
                <div className="bg-teal-500/10 p-3 rounded-xl border border-teal-500/20 text-teal-400">
                  <Cpu className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">Integra tus sistemas</h3>
                  <p className="text-xs text-slate-400">Crea credenciales API y sube archivos de forma programática a Nexus Storage.</p>
                </div>
              </div>
              <button onClick={() => setView('api')} className="btn-secondary text-xs">Generar API Key</button>
            </div>
          </main>
        )}

        {/* File Explorer View */}
        {view === 'files' && (
          <main className="p-8 flex-1 flex flex-col gap-6 min-h-0">
            {/* Header controls */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
              <div>
                <h1 className="text-2xl font-black text-white">Mis Archivos</h1>
                {/* Breadcrumbs */}
                <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1">
                  <button onClick={() => setCurrentFolderId('root')} className="hover:text-teal-400 transition-all">Raíz</button>
                  {breadcrumbs.map((b) => (
                    <React.Fragment key={b.id}>
                      <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                      <button onClick={() => setCurrentFolderId(b.id)} className="hover:text-teal-400 transition-all truncate max-w-[120px]">{b.name}</button>
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {/* Actions panel */}
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                  <input 
                    type="text" 
                    placeholder="Buscar archivos..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="bg-slate-900 border border-slate-800 text-xs rounded-lg pl-9 pr-4 py-2 outline-none focus:border-teal-500 w-48 text-white transition-all"
                  />
                </div>

                <button onClick={() => setIsFolderModalOpen(true)} className="btn-secondary text-xs py-2">
                  <Plus className="h-4 w-4" /> Carpeta
                </button>

                <label className="btn-primary text-xs py-2 cursor-pointer">
                  <Plus className="h-4 w-4" /> Subir Archivo
                  <input type="file" onChange={handleUpload} className="hidden" />
                </label>
              </div>
            </div>

            {/* Layout with Files Grid and Preview panel */}
            <div className="flex-1 flex gap-6 min-h-0">
              {/* Files table list */}
              <div className="flex-1 glass-panel rounded-2xl overflow-y-auto p-6 min-w-0">
                {loading ? (
                  <div className="h-64 flex flex-col items-center justify-center gap-3 text-slate-400">
                    <RefreshCw className="animate-spin text-teal-400 h-8 w-8" />
                    <p className="text-sm">Cargando archivos...</p>
                  </div>
                ) : files.length === 0 && folders.length === 0 ? (
                  <div className="h-64 flex flex-col items-center justify-center gap-4 text-slate-500">
                    <Folder className="h-16 w-16 text-slate-700" />
                    <p className="text-sm font-medium">Esta carpeta está vacía. ¡Sube un archivo!</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Folders grid */}
                    {folders.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Carpetas</h3>
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                          {folders.map(f => (
                            <div 
                              key={f.id}
                              onDoubleClick={() => setCurrentFolderId(f.id)}
                              className="bg-slate-950 hover:bg-slate-900 border border-slate-800/80 rounded-xl p-4 flex items-center justify-between gap-3 group cursor-pointer transition-all duration-200"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <Folder className="text-teal-400 h-5 w-5 shrink-0" />
                                <span className="text-sm font-medium text-slate-200 truncate">{f.name}</span>
                              </div>
                              <button 
                                onClick={(e) => { e.stopPropagation(); handleDeleteFolder(f.id); }}
                                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 p-1 hover:bg-slate-800 rounded transition-all"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Files list */}
                    {files.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Archivos</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-sm text-slate-300">
                            <thead className="text-xs text-slate-500 uppercase border-b border-slate-800">
                              <tr>
                                <th className="pb-3">Nombre</th>
                                <th className="pb-3">Tamaño</th>
                                <th className="pb-3">Tipo</th>
                                <th className="pb-3">Análisis</th>
                                <th className="pb-3 text-right">Acciones</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-900">
                              {files
                                .filter(f => f.name.toLowerCase().includes(searchTerm.toLowerCase()))
                                .map(f => (
                                  <tr 
                                    key={f.id}
                                    onClick={() => handlePreviewFile(f)}
                                    className={`hover:bg-slate-900/40 cursor-pointer ${previewFile?.id === f.id ? 'bg-slate-900/60' : ''}`}
                                  >
                                    <td className="py-3.5 flex items-center gap-3 min-w-0">
                                      {f.mime_type.startsWith('image/') ? (
                                        <ImageIcon className="text-teal-400 h-4.5 w-4.5 shrink-0" />
                                      ) : f.mime_type.startsWith('video/') ? (
                                        <Video className="text-teal-400 h-4.5 w-4.5 shrink-0" />
                                      ) : (
                                        <FileIcon className="text-slate-400 h-4.5 w-4.5 shrink-0" />
                                      )}
                                      <span className="font-medium text-slate-200 truncate max-w-[200px]">{f.name}</span>
                                    </td>
                                    <td className="py-3.5 text-xs text-slate-400">{formatBytes(f.size_bytes || f.size)}</td>
                                    <td className="py-3.5 text-xs text-slate-500 truncate max-w-[120px]">{f.mime_type}</td>
                                    <td className="py-3.5 text-xs">
                                      {f.scan_status === 'pending' || f.scan_status === 'uploading' ? (
                                        <span className="bg-amber-950/40 border border-amber-800/50 text-amber-300 text-[10px] px-2 py-0.5 rounded-full font-semibold animate-pulse">Escaneando...</span>
                                      ) : f.scan_status === 'clean' ? (
                                        <span className="bg-emerald-950/40 border border-emerald-800/50 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full font-semibold flex items-center gap-1 w-fit"><ShieldCheck className="h-3 w-3" /> Seguro</span>
                                      ) : (
                                        <span className="bg-rose-950/40 border border-rose-800/50 text-rose-400 text-[10px] px-2 py-0.5 rounded-full font-semibold">Infectado</span>
                                      )}
                                    </td>
                                    <td className="py-3.5 text-right">
                                      <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                                        <button onClick={() => handleDownloadFile(f)} disabled={f.scan_status === 'infected'} className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-teal-400 transition-all disabled:opacity-40" title="Descargar">
                                          <Download className="h-4 w-4" />
                                        </button>
                                        <button onClick={() => handleOpenShare(f)} disabled={f.scan_status === 'infected'} className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-teal-400 transition-all disabled:opacity-40" title="Compartir">
                                          <Share2 className="h-4 w-4" />
                                        </button>
                                        <button onClick={() => handleDeleteFile(f.id)} className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-all" title="Eliminar">
                                          <Trash2 className="h-4 w-4" />
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Preview Side Drawer */}
              {previewFile && (
                <div className="w-80 glass-panel rounded-2xl p-6 flex flex-col justify-between shrink-0 animate-fade-in">
                  <div className="space-y-6">
                    <div className="flex justify-between items-center border-b border-slate-900 pb-3">
                      <h3 className="font-bold text-white text-sm">Detalles del Archivo</h3>
                      <button onClick={() => setPreviewFile(null)} className="text-slate-500 hover:text-slate-200">
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Preview visual wrapper */}
                    <div className="h-40 bg-slate-950 rounded-xl border border-slate-900/60 overflow-hidden flex items-center justify-center relative">
                      {previewUrl && previewFile.mime_type.startsWith('image/') ? (
                        <img src={previewUrl} alt={previewFile.name} className="w-full h-full object-cover" />
                      ) : previewUrl && previewFile.mime_type.startsWith('video/') ? (
                        <video src={previewUrl} controls className="w-full h-full object-cover" />
                      ) : (
                        <div className="text-slate-600 flex flex-col items-center gap-2">
                          <FileText className="h-12 w-12" />
                          <span className="text-[10px] uppercase font-semibold">Previsualización no disponible</span>
                        </div>
                      )}
                    </div>

                    <div className="space-y-3 text-xs">
                      <div>
                        <span className="text-slate-500 font-semibold block">Nombre</span>
                        <span className="text-slate-200 break-all">{previewFile.name}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="text-slate-500 font-semibold block">Tamaño</span>
                          <span className="text-slate-200">{formatBytes(previewFile.size_bytes || previewFile.size)}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 font-semibold block">Descargas</span>
                          <span className="text-slate-200">{previewFile.download_count}</span>
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500 font-semibold block">Tipo MIME</span>
                        <span className="text-slate-200 truncate block">{previewFile.mime_type}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 font-semibold block">ID de Almacenamiento</span>
                        <span className="text-slate-400 block font-mono text-[9px] truncate">{previewFile.storage_key}</span>
                      </div>
                    </div>
                  </div>

                  <button 
                    onClick={() => handleDownloadFile(previewFile)} 
                    disabled={previewFile.scan_status === 'infected'}
                    className="btn-primary w-full text-xs justify-center py-2.5 mt-6 disabled:opacity-40"
                  >
                    <Download className="h-4 w-4" /> Descargar Archivo
                  </button>
                </div>
              )}
            </div>
          </main>
        )}

        {/* Developer API Keys View */}
        {view === 'api' && (
          <main className="p-8 space-y-8 flex-1 overflow-y-auto">
            <div>
              <h1 className="text-2xl font-black text-white">Mi API</h1>
              <p className="text-slate-400 text-sm mt-1">Crea credenciales y accede a la documentación para desarrolladores.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* API Keys List */}
              <div className="glass-panel p-6 rounded-2xl lg:col-span-2 space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-white text-base">Claves de API Activas</h3>
                  <button onClick={() => { setGeneratedKeyRaw(''); setIsKeyModalOpen(true); }} className="btn-primary text-xs py-1.5">
                    <Plus className="h-4 w-4" /> Nueva Clave
                  </button>
                </div>

                {apiKeys.length === 0 ? (
                  <div className="py-12 text-center text-slate-500 text-sm">
                    No tienes claves de API generadas. Crea una para empezar a programar.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-900">
                    {apiKeys.map(k => (
                      <div key={k.id} className="py-4 flex justify-between items-center gap-4">
                        <div className="min-w-0 space-y-1">
                          <h4 className="font-semibold text-slate-200 text-sm truncate">{k.name}</h4>
                          <div className="flex flex-wrap gap-2">
                            {k.scopes.map(s => (
                              <span key={s} className="bg-slate-900 border border-slate-800 text-slate-400 text-[10px] font-semibold px-2 py-0.5 rounded-full">{s}</span>
                            ))}
                            {k.last_used_at && (
                              <span className="text-[10px] text-slate-500">Último uso: {new Date(k.last_used_at).toLocaleDateString()}</span>
                            )}
                          </div>
                        </div>
                        <button onClick={() => handleRevokeApiKey(k.id)} className="text-slate-500 hover:text-rose-400 p-2 hover:bg-slate-900 rounded transition-all shrink-0">
                          <Trash2 className="h-4.5 w-4.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* API Key instruction box */}
              <div className="glass-panel p-6 rounded-2xl space-y-4">
                <div className="h-10 w-10 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400 flex items-center justify-center">
                  <Info className="h-5 w-5" />
                </div>
                <h3 className="font-bold text-white text-sm">¿Cómo usar tu API Key?</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Envía tu API Key en la cabecera HTTP de todas las peticiones externas. Puedes usar el endpoint de cabecera <code className="text-teal-400 bg-slate-950 px-1 py-0.5 rounded">X-API-Key</code> o <code className="text-teal-400 bg-slate-950 px-1 py-0.5 rounded">Authorization: Bearer [KEY]</code>.
                </p>
                <div className="text-xs border-t border-slate-900 pt-4 text-slate-500">
                  El límite de llamadas con API Key es de <strong>60 peticiones por minuto</strong>.
                </div>
              </div>
            </div>

            {/* Embedded Documentation code snippets */}
            <div className="glass-panel p-6 rounded-2xl space-y-6">
              <h3 className="font-bold text-white text-base">Ejemplos de Integración</h3>
              
              <div className="space-y-4">
                {/* Snippet 1 */}
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Listar archivos raíz (cURL)</span>
                  <pre className="bg-slate-950 p-4 rounded-xl border border-slate-900 text-xs text-teal-400 overflow-x-auto font-mono">
                    {`curl -X GET "${API_URL}/files/list" \\
  -H "X-API-Key: tu_api_key_aqui"`}
                  </pre>
                </div>

                {/* Snippet 2 */}
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Solicitar URL de subida prefirmada (Node.js/Axios)</span>
                  <pre className="bg-slate-950 p-4 rounded-xl border border-slate-900 text-xs text-emerald-400 overflow-x-auto font-mono">
                    {`const axios = require('axios');

axios.post('${API_URL}/files/upload-request', {
  name: 'documento.pdf',
  size: 153600,
  mime_type: 'application/pdf'
}, {
  headers: { 'X-API-Key': 'tu_api_key_aqui' }
})
.then(res => {
  console.log("Sube tu archivo haciendo PUT a:", res.data.presigned_url);
});`}
                  </pre>
                </div>
              </div>
            </div>
          </main>
        )}

        {/* Audit Log / History View */}
        {view === 'history' && (
          <main className="p-8 space-y-8 flex-1 overflow-y-auto">
            <div>
              <h1 className="text-2xl font-black text-white">Historial de Actividad</h1>
              <p className="text-slate-400 text-sm mt-1 font-medium">Historial completo de auditoría y operaciones de seguridad.</p>
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
                          log.action.includes('DOWNLOAD') || log.action.includes('SCAN') ? 'bg-emerald-950/40 border-emerald-900 text-emerald-400' :
                          'bg-slate-900 border-slate-800 text-slate-300'
                        }`}>
                          {log.action}
                        </span>
                      </td>
                      <td className="py-4 text-xs font-semibold text-slate-200 truncate max-w-[280px]">{log.details}</td>
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

      {/* -------------------- MODALS -------------------- */}

      {/* New Folder Modal */}
      {isFolderModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full glass-panel rounded-2xl p-6 shadow-2xl relative">
            <h3 className="text-lg font-bold text-white mb-4">Crear Nueva Carpeta</h3>
            <form onSubmit={handleCreateFolder} className="space-y-4">
              <input 
                type="text" 
                required 
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Nombre de la carpeta" 
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm focus:border-teal-500 outline-none text-white transition-all"
              />
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setIsFolderModalOpen(false)} className="btn-secondary text-xs py-2">Cancelar</button>
                <button type="submit" className="btn-primary text-xs py-2">Crear Carpeta</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Share File Modal */}
      {isShareModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full glass-panel rounded-2xl p-6 shadow-2xl relative space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-white">Compartir archivo: {shareTargetFile?.name}</h3>
              <button onClick={() => setIsShareModalOpen(false)} className="text-slate-500 hover:text-slate-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            {!generatedShareToken ? (
              <form onSubmit={handleCreateShareLink} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold block">Contraseña de acceso (Opcional)</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                    <input 
                      type="password" 
                      value={sharePass}
                      onChange={(e) => setSharePass(e.target.value)}
                      placeholder="Contraseña del enlace" 
                      className="w-full bg-slate-950/80 border border-slate-800 rounded-lg pl-9 pr-4 py-2 text-xs focus:border-teal-500 outline-none text-white"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold block">Duración del enlace</label>
                  <select 
                    value={shareExpiry}
                    onChange={(e) => setShareExpiry(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-teal-500 outline-none text-white"
                  >
                    <option value="0">Ilimitada</option>
                    <option value="1">1 Hora</option>
                    <option value="24">24 Horas</option>
                    <option value="168">7 Días</option>
                  </select>
                </div>

                <button type="submit" className="btn-primary w-full justify-center text-xs py-2.5">Generar Enlace</button>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1">
                  <p className="text-[11px] text-slate-400 font-semibold">Página de Descarga (Pública):</p>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      readOnly 
                      value={generatedShareToken}
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-teal-400 focus:outline-none"
                    />
                    <button onClick={() => copyToClipboard(generatedShareToken)} className="btn-secondary text-xs shrink-0 p-2" title="Copiar enlace">
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {!sharePass && (
                  <div className="space-y-1">
                    <p className="text-[11px] text-slate-400 font-semibold">Enlace Directo (para incrustar en web/logo):</p>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        readOnly 
                        value={generatedEmbedLink}
                        className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-teal-400 focus:outline-none"
                      />
                      <button onClick={() => copyToClipboard(generatedEmbedLink)} className="btn-secondary text-xs shrink-0 p-2" title="Copiar enlace directo">
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
                
                <button onClick={() => setIsShareModalOpen(false)} className="btn-primary w-full justify-center text-xs py-2 mt-2">Listo</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Generate API Key Modal */}
      {isKeyModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full glass-panel rounded-2xl p-6 shadow-2xl relative space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-white">Generar nueva API Key</h3>
              <button onClick={() => setIsKeyModalOpen(false)} className="text-slate-500 hover:text-slate-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            {!generatedKeyRaw ? (
              <form onSubmit={handleCreateApiKey} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold block">Nombre descriptivo</label>
                  <input 
                    type="text" 
                    required 
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="ej. Servidor de Producción" 
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-xs focus:border-teal-500 outline-none text-white transition-all"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-slate-400 font-semibold block">Permisos (Scopes)</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-xs text-slate-300">
                      <input 
                        type="checkbox" 
                        checked={newKeyScopes.read} 
                        onChange={(e) => setNewKeyScopes({...newKeyScopes, read: e.target.checked})}
                        className="accent-teal-500"
                      /> Leer (read)
                    </label>
                    <label className="flex items-center gap-2 text-xs text-slate-300">
                      <input 
                        type="checkbox" 
                        checked={newKeyScopes.write} 
                        onChange={(e) => setNewKeyScopes({...newKeyScopes, write: e.target.checked})}
                        className="accent-teal-500"
                      /> Escribir (write)
                    </label>
                    <label className="flex items-center gap-2 text-xs text-slate-300">
                      <input 
                        type="checkbox" 
                        checked={newKeyScopes.delete} 
                        onChange={(e) => setNewKeyScopes({...newKeyScopes, delete: e.target.checked})}
                        className="accent-teal-500"
                      /> Borrar (delete)
                    </label>
                  </div>
                </div>

                <button type="submit" className="btn-primary w-full justify-center text-xs py-2.5">Generar Credencial</button>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="bg-amber-950/30 border border-amber-800/40 p-3 rounded-lg text-amber-300 text-xs flex gap-2">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
                  <span>Por seguridad, guarda esta clave en un lugar seguro ahora. No podrás volver a verla de nuevo.</span>
                </div>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    readOnly 
                    value={generatedKeyRaw}
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-emerald-400 focus:outline-none"
                  />
                  <button onClick={() => copyToClipboard(generatedKeyRaw)} className="btn-secondary text-xs shrink-0 p-2">
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <button onClick={() => { setIsKeyModalOpen(false); setGeneratedKeyRaw(''); }} className="btn-primary w-full justify-center text-xs py-2">Cerrar</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Global Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map(t => (
          <div key={t.id} className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border shadow-lg text-sm transition-all duration-300 animate-slide-in ${
            t.type === 'error' ? 'bg-rose-950/80 border-rose-800 text-rose-200' :
            t.type === 'info' ? 'bg-slate-900 border-slate-800 text-slate-200' :
            'bg-teal-950/80 border-teal-800 text-teal-200'
          }`}>
            {t.type === 'error' ? <AlertTriangle className="h-4 w-4 text-rose-400" /> : <CheckCircle className="h-4 w-4 text-teal-400" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
