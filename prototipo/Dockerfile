# =============================================================================
#  Imagen unica para los seis microservicios.
# =============================================================================
#
# Los seis servicios comparten el mismo arbol de codigo y se diferencian solo
# por la variable SERVICIO. Esto se llama "single artifact, multiple roles":
#   - una sola imagen que construir, escanear y firmar;
#   - imposible que dos servicios corran versiones distintas de lib/;
#   - el registro de contenedores guarda 1 imagen en vez de 6.
#
# Construir:  docker build -t armonia .
# Ejecutar :  docker run -e SERVICIO=catalogo -p 8081:8081 armonia

FROM node:22-alpine

# Usuario sin privilegios: nunca ejecutar como root en produccion.
RUN addgroup -S armonia && adduser -S armonia -G armonia

WORKDIR /app

# El prototipo no tiene dependencias externas, pero se copia primero el
# manifiesto para aprovechar la cache de capas si algun dia las tuviera.
COPY package.json ./
COPY lib ./lib
COPY services ./services
COPY web ./web
COPY scripts ./scripts

USER armonia

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV LOG_FORMAT=json
ENV SERVICIO=gateway

# Health Endpoint Monitoring: el orquestador reinicia el contenedor si falla.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PUERTO||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SERVICIO=todos levanta la malla completa en un solo contenedor. Es la
# opcion para planes gratuitos de nube que solo permiten un servicio;
# NO es la topologia recomendada (se pierde el escalado independiente),
# pero permite publicar la demostracion sin costo.
CMD ["sh", "-c", "if [ \"$SERVICIO\" = \"todos\" ]; then node scripts/start-all.js; else node services/$SERVICIO/index.js; fi"]
