const main = () => {
  fetch("http://localhost:3000/paraphrase", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: `qbpdelim123
En los últimos meses he estado observando cómo las pequeñas decisiones diarias pueden transformar completamente nuestro estado de ánimo. A veces pensamos que cambiar nuestra vida requiere grandes acciones, pero la realidad es que un simple hábito —como salir a caminar diez minutos, ordenar un poco el escritorio o dedicar tiempo a una conversación sincera— puede marcar una diferencia enorme. Cuando empezamos a notar esos detalles, es como si la rutina dejara de ser un piloto automático y se volviera algo más consciente, más propio. Y en ese proceso vamos descubriendo nuevas formas de sentirnos mejor con nosotros mismos.

qbpdelim123
Hay momentos en los que uno siente que todo avanza demasiado rápido y que no alcanza a procesar todo lo que ocurre. En esos días, detenerse un instante puede ser un acto poderoso, casi necesario. Pensar en lo que realmente queremos, en lo que de verdad nos importa, nos permite filtrar el ruido del mundo y reenfocar nuestra energía. A veces no se trata de tener todas las respuestas, sino de hacer las preguntas correctas y darnos el espacio para escuchar lo que sentimos. Conectar con ese silencio es una manera de reencontrarnos y recuperar claridad.

qbpdelim123
Con el tiempo he aprendido que cada etapa trae sus propios desafíos y oportunidades, y que resistirse a ellos solo nos hace más pesado el camino. La vida cambia constantemente, y aceptar esa naturaleza dinámica nos permite adaptarnos mejor y crecer con menos frustración. Incluso las situaciones que parecen negativas suelen ocultar un aprendizaje valioso, una señal para ajustar el rumbo o soltar algo que ya no nos sirve. Cuando dejamos de pelear con la realidad y empezamos a fluir con ella, todo se vuelve más liviano, más sencillo, y empezamos a encontrar sentido en lugares inesperados.`,
    }),
  })
    .then((response) => response.json())
    .then((data) => {
      console.log("Paraphrase response:", data);
    })
    .catch((error) => {
      console.error("Error during paraphrasing request:", error);
    });
};

main();
