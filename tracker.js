let tournamentIds=[];

function fetchTournamentIDs(limit,game,format){
    fetch(`https://play.limitlesstcg.com/api/tournaments/?limit=${limit}&game=${game}&format=${format}`)
    .then(response=>{
        if(!response.ok){
            throw new Error('Network response not ok');
        }
        return response.json();
    })
    .then(tournaments=>{
        for (let i = 0; i < limit; i++) {
            tournamentIds.push(tournaments[i].id);
        }
        console.log(tournamentIds);
    })
    .catch(error=>{
        console.error('There was an error ', error);
    })
}

fetchTournamentIDs(100,"PTCG","STANDARD");