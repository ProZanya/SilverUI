FROM node:trixie
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --quiet
COPY . .
EXPOSE 3000
CMD [ "node", "server.js" ]