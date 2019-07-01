const AWS = require('aws-sdk');
AWS.config.region = 'us-east-1';
const lambda = new AWS.Lambda();
const execFile = require('child_process').execFile;
const path = require('path');
const _ = require('lodash');
const yaml = require('js-yaml');
const fs = require('fs');
const async = require('async');

const AMBIENTE = (process.env.NODE_ENV || process.env.STAGE || "").replace("development", "dev");

exports.log = function (info, msg) {
    console.log(msg ? msg : 'Received event:', JSON.stringify(info, null, 2));
}

exports.init = function (event, context, waitEventLoop) {
    exports.log(event);
    context.callbackWaitsForEmptyEventLoop = !!waitEventLoop;
    global.lambdaFunctionName = context.functionName;
}

exports.montaNomeFuncao = function (servico, funcao, ambiente) {    
    return servico + "-" + (ambiente || AMBIENTE) + "-" + funcao;
}

exports.invokeLambdaServico = function(servico, funcao, payload, callback){
    var fnName = exports.montaNomeFuncao(servico, funcao);
    var params = {
        FunctionName: fnName,
        Payload: JSON.stringify(payload)
    };
    exports.invokeLambda(params, callback);
}

exports.invokeLambdaServicoEvento = function(servico, funcao, payload, callback){
    var fnName = exports.montaNomeFuncao(servico, funcao);
    var params = {
        FunctionName: fnName,
        Payload: JSON.stringify(payload),
        InvocationType: 'Event'
    };
    exports.invokeLambda(params, callback);
}

exports.invokeLambda = function (params, callback) {
    if (process.env.IS_LOCAL || process.env.LOCAL_LAMBDA || AMBIENTE === "development" || AMBIENTE === "qualidade" || AMBIENTE === "dev") {
        return lambdaLocal(params, callback);
    }
    return lambda.invoke(params, callback);
}

function getLambdaInfo(fnName) {

    var cwd;
    var fnNameSplited = fnName.split('-');
    var tipo = fnNameSplited[1];
    var fnFolder = fnNameSplited[2];
    var stage = fnNameSplited[3];
    if (stage == "development") stage = 'dev';

    if(process.env.NOVOERP_LAMBDA_FOLDER){
        cwd = path.join(process.env.NOVOERP_LAMBDA_FOLDER, tipo, fnFolder);
    }else if (process.env.IS_LOCAL) { //Chamada de lambda
        if(process.env.IS_ROOT){
            if(tipo === 'java'){
                cwd = path.join(process.cwd(), '..', '..', tipo, fnFolder);
            }else{
                cwd = process.cwd();    
            }   
        }else{
            cwd = path.join(process.cwd(), '..');
            if(path.basename(cwd) == "node" || path.basename(cwd) == "java"){
                cwd = process.cwd();
            }
        }
    } else {
        if (AMBIENTE === "development" || AMBIENTE === "dev" || process.env.LOCAL_LAMBDA === "true") {
            cwd = path.join(process.cwd(), '..', 'lambda', tipo, fnFolder);
        } else {
            cwd = path.join(process.cwd(), 'lambda', tipo, fnFolder);
        }
    }

    fnNameSplited.splice(0, 4);

    return {
        cwd: cwd,
        stage: stage,
        name: fnNameSplited.join('-'),
        tipo: tipo
    };

}

function lambdaLocal(params, callback) {

    var fnName = params.FunctionName;
    var info = getLambdaInfo(fnName);

    var fnPointer

    switch (info.tipo) {
        case "node":
            fnPointer = lambdaLocalNode;
            break;
        case "java":
            fnPointer = lambdaLocalJava;
            break;
        default:
            throw new Error("Tipo de lambda local inválido!");
    }

    fnPointer(params, info, callback);

}

function lambdaLocalNode(params, info, callback) {

    var paramsExec = ['invoke', 'local', '-f', info.name, '--stage', info.stage, '--data', params.Payload];
    console.log("Executando lambda local: " + path.join(info.cwd, "sls") + " " + paramsExec.join(" "));
    
    if(callback === undefined){
        callback = function(){};
    }

    const child = execFile('sls', paramsExec, {
        cwd: info.cwd,
        env: process.env,
        maxBuffer: 1024 * 500 
    }, (error, stdout, stderr) => {
        if (error) {
            var indexRetOffline = (stdout||"").indexOf("---RETORNOOFFLINE---");
            if(indexRetOffline > -1){
                var split = stdout.split("---RETORNOOFFLINE---")[1];
                if (!split) {
                    split = "";
                }
                var json = split.trim();
                if(json){
                    json = json.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
                    var response = JSON.parse(json);
                    if(response.errorMessage && typeof response.errorMessage == "object"){
                        response = response.errorMessage;
                    }
                    return callback(new Error(response.message || response.errorMessage));
                }else{
                    return callback(new Error(stderr));
                } 
            }else{
                return callback(new Error(stderr));
            }   
        }
        try {
            var split = stdout.split("---RETORNOOFFLINE---")[1];
            if (!split) {
                split = "";
            }
            var json = split.trim();
            if (json === "") json = "{}";
            var response = JSON.parse(json);
        } catch (e) {
            e.message = "Erro ao fazer parse na resposta: " + e.message + "\n\nResposta: " + stdout;
            return callback(e);
        }
        return callback(null, {
            Payload: response
        });
    });

}

//java -cp target/api-dev.jar avanco.lambda.nfe.LambdaFunctionHandler
function lambdaLocalJava(params, info, callback) {

    if(callback === undefined){
        callback = function(){};
    }

    async.waterfall([
        function getClassHandler(next) {
            try {
                var doc = yaml.safeLoad(fs.readFileSync(path.join(info.cwd, "serverless.yml"), 'utf8'));
                var classHandler = doc.functions[info.name].handler;
                next(null, classHandler);
            } catch (e) {
                next(e);
            }
        },
        function checkSeJarExiste(classHandler, next) {
            if (!fs.existsSync(path.join(info.cwd, "target/" + info.name + ".jar"))) {
                var paramsExec = ['package'];
                const child = execFile('mvn', paramsExec, {
                    cwd: info.cwd,
                    maxBuffer: 1024 * 500 
                }, (error, stdout, stderr) => {
                    if (error) {
                        return next(error);
                    }
                    next(null, classHandler);
                });
            } else {
                next(null, classHandler);
            }
        },
        function executar(classHandler, next) {

            var paramsExec = ['-cp', "target/" + info.name + ".jar", classHandler, params.Payload];
            var exec = "java";
            if (info.stage == "qualidade" && fs.existsSync("/u/java/jdk1.8/bin/"+exec)){
                exec = "/u/java/jdk1.8/bin/"+exec;
            }
            console.log("Executando lambda local: " + path.join(info.cwd, exec) + " " + paramsExec.join(" "));

            var env = JSON.parse(JSON.stringify(process.env));
            var envFile;
            
            if(fs.existsSync(path.join(info.cwd, "../../config.js"))){
                envFile = require(path.join(info.cwd, "../../config.js"))(info.stage);
                _.assign(env, envFile.env);
            }else if(fs.existsSync(path.join(info.cwd, "../../env.js"))){
                envFile = require(path.join(info.cwd, "../../env.js"))(info.stage);
                _.assign(env, envFile);
            }else{
                return next(new Error('Arquivo de configuração da lambda (config.js|env.js) não encontrado!'));
            }          

            _.assign(env, envFile.env);

            const child = execFile(exec, paramsExec, {
                cwd: info.cwd,
                env: env,
                maxBuffer: 1024 * 500 
            }, (error, stdout, stderr) => {
                if (error) {
                    return callback(new Error(stderr));
                }
                try {
                    var response = stdout.split("---RETORNOOFFLINE---")[1];
                    if (!response) {
                        response = "";
                    }
                    response = response.trim();
                } catch (e) {
                    e.message = "Erro ao fazer parse na resposta: " + e.message + "\n\nResposta: " + stdout;
                    return callback(e);
                }
                return next(null, {
                    Payload: response
                });
            });

        }
    ], (err, result) => {
        callback(err, result);
    });

}