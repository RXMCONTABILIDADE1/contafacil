# ContaFácil — Sistema de Obrigações Acessórias
Sistema web completo para gestão de obrigações acessórias de escritórios de contabilidade.
Suporta clientes do **Simples Nacional** e **Lucro Presumido**.

---

## Requisitos

- **Node.js** versão 18 ou superior → https://nodejs.org
- Windows, macOS ou Linux

---

## Instalação passo a passo

### 1. Instale o Node.js
Acesse https://nodejs.org e baixe a versão **LTS**. Instale normalmente.

### 2. Copie a pasta do projeto
Coloque a pasta `contafacil` em qualquer lugar do seu computador, por exemplo:
```
C:\contafacil\        (Windows)
/home/usuario/contafacil/   (Linux/Mac)
```

### 3. Abra o terminal na pasta do projeto
- **Windows**: clique com botão direito dentro da pasta → "Abrir no Terminal"
- **Mac/Linux**: abra o Terminal e use `cd /caminho/para/contafacil`

### 4. Instale as dependências
```bash
npm install
```

### 5. Configure o arquivo .env
Copie o arquivo `.env.example` para `.env`:
```bash
# Windows:
copy .env.example .env

# Mac/Linux:
cp .env.example .env
```
Abra o arquivo `.env` com o Bloco de Notas (ou VS Code) e preencha:
```
SESSION_SECRET=qualquer_texto_longo_e_aleatorio_aqui
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seu_email@gmail.com
SMTP_PASS=sua_senha_de_app_do_gmail
EMAIL_FROM=ContaFácil <seu_email@gmail.com>
EMAIL_ESCRITORIO=contabilidade@seuescritorio.com.br
```

> **Como gerar senha de app no Gmail:**
> 1. Acesse myaccount.google.com
> 2. Segurança → Verificação em duas etapas (ative se necessário)
> 3. Senhas de app → selecione "Outro" → gere a senha
> 4. Cole essa senha de 16 caracteres no campo `SMTP_PASS`

### 6. Inicie o sistema
```bash
npm start
```

### 7. Acesse no navegador
Abra: **http://localhost:3000**

**Login padrão:**
- E-mail: `admin@contafacil.com`
- Senha: `admin123`

---

## Funcionalidades

- Dashboard com métricas em tempo real
- Gestão de tarefas e obrigações (criar, editar, mudar status, excluir)
- Calendário fiscal mensal com filtro por regime
- Cadastro de clientes (Simples Nacional e Lucro Presumido)
- Notificações automáticas de prazo
- **Alertas por e-mail** automáticos todos os dias às 7h
- **Atualização automática** de status "Em atraso" à meia-noite
- Exportação CSV de todas as tarefas
- Configuração de e-mail pelo painel web
- Banco de dados SQLite local (arquivo `db/contafacil.db`)

---

## Obrigações cadastradas

### Simples Nacional
- DAS, PGDAS-D, DEFIS, DeSTDA

### Lucro Presumido
- DCTF Mensal, IRPJ/CSLL Estimativa, ECF, ECD, SPED Contribuições, SPED Fiscal, DARF PIS/COFINS

### Comuns a ambos
- e-Social, EFD-REINF, DCTFWeb, DIRF, RAIS, CAGED, Folha de Pagamento, FGTS

---

## Iniciar automaticamente com o Windows

Para o sistema iniciar junto com o Windows:
1. Instale o `pm2`: `npm install -g pm2`
2. Inicie com pm2: `pm2 start server.js --name contafacil`
3. Configure para iniciar com o Windows: `pm2 startup` (siga as instruções)
4. Salve: `pm2 save`

---

## Backup dos dados

O banco de dados fica em `db/contafacil.db`. Faça backup periódico desse arquivo.

---

## Suporte

Sistema gerado por ContaFácil · Node.js + SQLite + Express
