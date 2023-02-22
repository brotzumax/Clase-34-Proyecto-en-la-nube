//Requisitos
const express = require('express');
const fs = require('fs');
const { Server: HttpServer } = require('http');
const { Server: IOServer } = require('socket.io');
const ClienteSQL = require('./db/sqlContainer').ClienteSQL;
const optionsMariaDB = require('./options/mysqlconn').options;

//MongoDB
const mongoose = require('mongoose');
const mongoConfig = require('./options/mongodbconn').options;
const modelMensaje = require('./models/mensaje');


//Normalizr
const normalizr = require('normalizr');
const util = require('util');

const normalize = normalizr.normalize;
const schema = normalizr.schema;

//Esquemas normalizacion
const author = new schema.Entity('authors', {}, { idAttribute: 'email' });
const message = new schema.Entity('messages', { author: author }, { idAttribute: 'id' });
const mensajeria = new schema.Entity('mensajeria', { messages: [message] }, { idAttribute: 'id' });


//Cookies
const cookieParser = require('cookie-parser');


//Session
const session = require('express-session');
const MongoStore = require('connect-mongo');
const advancedOptions = { useNewUrlParser: true, useUnifiedTopology: true };


//Métodos
function print(objeto) {
    console.log(util.inspect(objeto, false, 12, true));
}

function convertirArray(array) {
    let nuevoArray = [];
    for (mensaje of array) {
        nuevoArray.push({ id: mensaje._id.toString(), author: mensaje.author, text: mensaje.text, date: mensaje.date });
    };
    return nuevoArray;
}

function sessionPersistence(req, res, next) {
    if (req.session.user) {
        req.session.touch();
        next();
    } else {
        res.redirect("/login");
    }
}


//.env
require('dotenv').config();


//Minimist
const parseArgs = require('minimist');
const argsOptions = { alias: { p: 'puerto', m: 'modo' }, default: { puerto: 8080, modo: "FORK" } };
const args = parseArgs(process.argv.slice(2), argsOptions);


//Fork
const { fork } = require('child_process');

//Cluster
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

//Gzip
const compression = require('compression')

//Winston
const winston = require('winston');

const logger = winston.createLogger({
    level: 'verbose',
    transports: [
        new winston.transports.Console({ level: 'info' }),
        new winston.transports.File({ filename: 'warn.log', level: 'warn' }),
        new winston.transports.File({ filename: 'error.log', level: 'error' })
    ]
});


//Inicio de servidor
const app = express();
const httpServer = new HttpServer(app);
const io = new IOServer(httpServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cookieParser());
app.use(session({
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URL,
        mongoOptions: advancedOptions
    }),
    secret: 'secreto',
    resave: true,
    saveUninitialized: true,
    cookie: { maxAge: 60000 }
}));

app.use(compression());


//Middleware winston
app.use((req, res, next) => {
    logger.info(`Request to ${req.url} - Method: ${req.method}`);
    next();
});


let sqlProductos = new ClienteSQL(optionsMariaDB, "productos");


//Ejs
app.set('view engine', 'ejs');

//Peticiones del servidor
app.get("/login", (req, res) => {
    res.render("pages/login");
});

app.post("/login", (req, res) => {
    const username = req.body.txtUsuario;
    req.session.user = username;
    res.redirect('/');
});

app.get("/logout", (req, res) => {
    res.render("pages/logout", { username: req.session.user });
    req.session.destroy();
});

app.get("/", sessionPersistence, (req, res) => {
    res.render("pages/index", { username: req.session.user });
});

app.get("/api/productos-test", sessionPersistence, (req, res) => {
    res.render("pages/testView");
});

app.get("/info", (req, res) => {
    res.send(
        "<h1>Información de la aplicación</h1>" +
        "<div style='display: flex; flex-direction: column'>" +
        "<span>Argumentos de entrada: -p (puerto), -m (modo: FORK - CLUSTER)</span>" +
        `<span>Nombre de la plataforma: ${process.platform}</span>` +
        `<span>Versión de node.js: ${process.version}</span>` +
        `<span>Memoria total reservada (rss): ${process.memoryUsage().rss}</span>` +
        `<span>Path de ejecución:  ${process.execPath}</span>` +
        `<span>Process id: ${process.pid}</span>` +
        `<span>Carpeta del proyecto: ${process.cwd()}</span>` +
        `<span>Número de procesadores: ${numCPUs}</span>` +
        "</div>"
    );
});

/* app.get("/api/randoms", (req, res) => {
    let cantidadNumeros = Number(req.query.cant);
    const calculo = fork('numerosRandom.js');

    calculo.on('message', resultado => {
        if (resultado == "Listo") {
            calculo.send(cantidadNumeros);
        } else {
            res.json(resultado);
        }
    });
}); */

//Midleware para peticiones no encontradas
app.use((req, res) => {
    logger.warn(`Petición ${req.url} no encontrada`);
    res.status(404).send('Página no encontrada');
});

//Websocket
io.on('connection', function (socket) {
    console.log("Cliente conectado");

    sqlProductos = new ClienteSQL(optionsMariaDB, "productos");
    sqlProductos.obtenerProductos()
        .then(productos => socket.emit('productos', productos));

    mongoose.set('strictQuery', true);
    mongoose.connect("mongodb://localhost:27017/mensajeria", mongoConfig)
        .then(() => modelMensaje.find({}))
        .then(data => {
            const chat = {
                id: "mensajes",
                messages: convertirArray(data)
            };
            const mensajesNormalizados = normalize(chat, mensajeria);
            io.sockets.emit('mensajes', mensajesNormalizados);
        })
        .catch((err) => logger.error(err));



    socket.on("nuevo-producto", producto => {
        sqlProductos = new ClienteSQL(optionsMariaDB, "productos");
        sqlProductos.insertarElemento(producto)
            .then(() => sqlProductos.obtenerProductos())
            .then(productos => socket.emit('productos', productos));
    });

    socket.on("nuevo-mensaje", message => {
        mongoose.set('strictQuery', true);
        mongoose.connect("mongodb://localhost:27017/mensajeria", mongoConfig)
            .then(() => modelMensaje.create(message))
            .then(() => console.log("Mensaje guardado"))
            .then(() => modelMensaje.find({}))
            .then(data => {
                const chat = {
                    id: "mensajes",
                    messages: convertirArray(data)
                };
                const mensajesNormalizados = normalize(chat, mensajeria);
                io.sockets.emit('mensajes', mensajesNormalizados);
            })
            .catch((err) => logger.error(err));
    })
});

//Escucha del servidor
if (args.modo === "FORK") {
    console.log("Servidor modo fork");
    httpServer.listen(args.puerto, () => {
        console.log(`Servidor escuchando en puerto ${args.puerto}`);
    });
} else if (args.modo === "CLUSTER") {
    if (cluster.isMaster) {
        console.log("Servidor modo cluster");
        console.log(`Master ${process.pid} is running`);

        for (let i = 0; i < numCPUs; i++) {
            cluster.fork();
        }

        cluster.on('exit', (worker, code, signal) => {
            console.log(`Worker ${worker.process.pid} died`);
        });
    } else {
        httpServer.listen(args.puerto, () => {
            console.log(`Servidor escuchando en puerto ${args.puerto}`);
        });
        console.log(`Worker ${process.pid} started`);
    }
} else {
    console.log(`${args.modo} no es un modo compatible (FORK - CLUSTER)`);
}

