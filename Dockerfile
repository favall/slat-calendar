FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN apk add --no-cache curl && npm install --omit=dev
COPY index.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]
