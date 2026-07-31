# Nexus Storage

Nexus Storage es una plataforma segura, moderna y auto-hospedada de almacenamiento de objetos en la nube (similar a S3 o Firebase Storage), desarrollada por **Nexus Digital Solutions**.

Este proyecto está diseñado para funcionar de forma completamente contenedorizada con **Docker**, lo que facilita el despliegue automático en servidores gestionados por **Coolify**.

---

## Arquitectura de MinIO en Nexus Storage

Para responder a la pregunta fundamental de diseño: **¿Debe instalarse MinIO por cliente o como un servicio independiente?**

**Respuesta: MinIO se despliega como un único servicio centralizado.**
- En un modelo de tipo SaaS/Storage de producción, tener un contenedor de MinIO independiente por cada cliente generaría un overhead inaceptable en términos de CPU, memoria y almacenamiento, además de hacer inviable la gestión de red.
- En su lugar, **Nexus Storage utiliza una arquitectura multi-tenant sobre una sola instancia de MinIO**.
- El aislamiento de los datos se realiza a nivel del backend de Go:
  1. Todos los archivos se guardan en un único bucket (`nexus-storage`).
  2. Cada cliente tiene sus archivos organizados bajo un prefijo virtual único en el bucket: `uploads/{user_id}/{file_uuid}/{filename}`.
  3. **Seguridad Absoluta:** Los clientes nunca reciben credenciales maestras de MinIO. Para subir o descargar archivos, solicitan URLs temporales prefirmadas generadas dinámicamente por la API de Go (las cuales expiran en 5 y 15 minutos respectivamente).
  4. La API de Go y la base de datos PostgreSQL validan las cuotas de almacenamiento, los permisos ACL y si el usuario está suspendido en cada petición, manteniendo un aislamiento perfecto entre los clientes.

---

## Stack Tecnológico

- **Backend:** Go 1.21+ con el framework web **Fiber** (por su velocidad, minimalismo y middleware maduro).
- **ORM:** **GORM** con base de datos PostgreSQL. Elegido por su facilidad de migración, soporte nativo de transacciones, soft-deletes y la velocidad de modelado de relaciones complejas.
- **Base de Datos:** PostgreSQL (para metadatos de archivos, carpetas, cuotas, planes, API keys y logs de auditoría).
- **Caché y Colas:** Redis (para rate limiting por IP/API Key y colas de tareas asíncronas de escaneo).
- **Almacenamiento Físico:** MinIO (servidor compatible con S3).
- **Frontend Cliente:** React + Vite + TailwindCSS (Single Page Application para clientes).
- **Frontend Administrador:** React + Vite + TailwindCSS (Single Page Application para administradores).
- **Contenerización:** Docker multi-stage builds orquestado mediante `docker-compose.yml`.

---

## Estructura del Proyecto

```
/nexus-storage
├── logo.png                      # Logo oficial del sistema
├── docker-compose.yml            # Orquestación de servicios
├── .env.example                  # Plantilla de variables de entorno
├── README.md                     # Este archivo
├── backend/                      # Backend en Go
│   ├── Dockerfile
│   ├── cmd/
│   │   └── api/
│   │       └── main.go           # Entrada del servidor
│   ├── internal/                 # Lógica de negocio encapsulada
│   └── pkg/
├── frontend-cliente/             # Panel del Cliente (React)
│   ├── Dockerfile
│   └── src/
├── frontend-admin/               # Panel del Administrador (React)
│   ├── Dockerfile
│   └── src/
└── docs/                         # Documentación adicional
```

---

## Despliegue con Docker Compose (Local y Coolify)

### Requisitos Previos
- Docker y Docker Compose instalados.

### Instrucciones de Instalación Local

1. Copia el archivo de configuración de variables de entorno:
   ```bash
   cp .env.example .env
   ```

2. Levanta todo el stack con Docker Compose:
   ```bash
   docker-compose up --build
   ```

3. Accede a las interfaces:
   - **Panel del Cliente:** [http://localhost:5173](http://localhost:5173)
   - **Panel del Administrador:** [http://localhost:5174](http://localhost:5174)
   - **Consola de Administración de MinIO (Opcional):** [http://localhost:9001](http://localhost:9001) (Usuario: `nexus_minio_admin` / Clave: `nexus_minio_admin_secret`)
   - **API REST Backend:** [http://localhost:8080](http://localhost:8080)

---

## Despliegue en Coolify

Este repositorio está estructurado para que Coolify pueda leer e importar el stack directamente desde el archivo `docker-compose.yml`.
1. Crea un nuevo servicio en Coolify de tipo **Docker Compose**.
2. Apunta Coolify a tu repositorio de Git.
3. Configura las variables de entorno en el panel de Coolify basándote en `.env.example`.
4. Coolify construirá automáticamente cada contenedor usando sus respectivos `Dockerfile` y expondrá los puertos de forma segura usando Traefik como proxy reverso con TLS.

