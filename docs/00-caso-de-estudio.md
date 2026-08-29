# 0. Caso de estudio — Armonía S.A.S.

> **Nota metodológica importante.** La guía de la actividad indica que el caso de estudio lo
> entrega el docente. Al no disponer de ese documento al momento de elaborar este trabajo, se
> construyó el caso que sigue respetando literalmente las restricciones del enunciado: una
> **empresa ficticia** que **busca mejorar su infraestructura tecnológica** y que exige una
> solución **modular, escalable y desplegable en la nube**. Si el enunciado oficial describe
> otra empresa, basta con sustituir este capítulo: el análisis de requisitos, los diagramas y
> los patrones se sostienen sobre las mismas fuerzas arquitectónicas (picos de demanda,
> transacciones distribuidas, dependencias externas poco confiables).

---

## 1. La empresa

**Armonía S.A.S.** es una empresa colombiana fundada en 2016 en Medellín que comercializa
boletería para conciertos, festivales y espectáculos en vivo. Opera en Bogotá, Medellín, Cali
y Barranquilla, y en 2025 vendió **1,8 millones de boletas** para 340 eventos, con una
facturación de 210 000 millones de pesos.

Su plataforma actual es una aplicación **monolítica en PHP** con una única base de datos MySQL,
desplegada en dos servidores físicos en un centro de datos alquilado en Bogotá.

## 2. El problema

El negocio de la boletería tiene una característica que lo hace arquitectónicamente
excepcional: **la demanda no es una curva, es un pico**. Cuando se abre la venta de un artista
importante —lo que la industria llama el *onsale*— la plataforma pasa de 200 usuarios
concurrentes a más de 90 000 en menos de 60 segundos, sostiene esa carga entre 10 y 20 minutos
y vuelve a la línea base. El resto del mes el sistema está prácticamente ocioso.

El monolito no soporta ese perfil. En los últimos 18 meses:

| Fecha | Incidente | Impacto |
|---|---|---|
| Mar 2025 | Caída completa 47 min durante el *onsale* de un festival | 1 900 millones COP en ventas perdidas |
| Jun 2025 | Doble cobro a 3 200 clientes por reintentos del cliente móvil | 340 millones COP en devoluciones + sanción de la SIC |
| Ago 2025 | Sobreventa de 180 boletas en una localidad numerada | Reubicación y reembolsos; daño reputacional |
| Nov 2025 | El proveedor de correo se cayó y arrastró todo el flujo de compra | 6 h sin ventas |
| Ene 2026 | Un despliegue del módulo de reportes tumbó la venta | 2 h sin ventas |

Los cinco incidentes tienen la misma raíz arquitectónica: **todo está acoplado a todo**.
No hay forma de escalar solo la venta, de aislar el fallo de un proveedor externo, de desplegar
un módulo sin arriesgar los demás, ni de garantizar que un reintento no cobre dos veces.

## 3. Restricciones y expectativas

La dirección aprobó una modernización con estas condiciones:

**Restricciones de negocio**

- **RB-1.** Presupuesto de infraestructura ≤ 8 000 USD/mes en operación normal.
- **RB-2.** El costo debe crecer con la demanda y **bajar** fuera de los picos (pago por uso).
- **RB-3.** La migración debe ser incremental: no se puede apagar el monolito de un día para otro.
- **RB-4.** Cumplimiento de la Ley 1581 de 2012 (protección de datos personales) y PCI-DSS
  para los datos de tarjeta.
- **RB-5.** El equipo es de 9 desarrolladores; la solución no puede exigir un equipo de plataforma
  dedicado.

**Restricciones técnicas**

- **RT-1.** Despliegue en nube pública, con contenedores.
- **RT-2.** Integración obligatoria con tres medios de pago: tarjeta, **PSE** y billeteras
  digitales (Nequi/Daviplata). Ninguno de los tres es confiable al 100 %.
- **RT-3.** Integración con los sistemas de control de acceso de 14 recintos, cada uno con su
  propio formato.
- **RT-4.** Los datos de tarjeta **no pueden almacenarse** en la plataforma.

**Expectativas explícitas de la dirección**

1. Que un *onsale* de 100 000 personas no tumbe la plataforma.
2. Que **nunca** se venda una boleta que no existe, ni se cobre dos veces.
3. Que la caída de un proveedor externo degrade el servicio, no lo apague.
4. Que el equipo pueda desplegar una mejora de catálogo sin tocar el motor de ventas.
5. Que un incidente se pueda diagnosticar en minutos, no en horas.

## 4. Alcance del prototipo

El prototipo de esta entrega **no** reimplementa toda la plataforma. Cubre el flujo crítico
—consultar catálogo, comprar boletas, pagar, notificar— porque es donde se concentran las cinco
expectativas anteriores y todas las fuerzas arquitectónicas del caso.

**Dentro del alcance:** catálogo y disponibilidad, reserva y compra, pago con tres pasarelas,
notificaciones, observabilidad y resiliencia.

**Fuera del alcance:** control de acceso en recinto, liquidación con promotores, reportería
financiera, gestión de usuarios y devoluciones masivas por cancelación de evento.

---

**Anterior:** — · **Siguiente:** [1. Análisis de requisitos](01-analisis-requisitos.md)
